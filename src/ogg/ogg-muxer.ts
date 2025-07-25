/*!
 * Copyright (c) 2025-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { OPUS_INTERNAL_SAMPLE_RATE, validateAudioChunkMetadata } from '../codec';
import { parseModesFromVorbisSetupPacket, parseOpusIdentificationHeader } from '../codec-data';
import { assert, promiseWithResolvers, setInt64, toDataView, toUint8Array } from '../misc';
import { Muxer } from '../muxer';
import { Output, OutputAudioTrack } from '../output';
import { OggOutputFormat } from '../output-format';
import { EncodedPacket } from '../packet';
import { Writer } from '../writer';
import {
	buildOggMimeType,
	computeOggPageCrc,
	extractSampleMetadata,
	OggCodecInfo,
	OGGS,
} from './ogg-misc';
import { MAX_PAGE_SIZE } from './ogg-reader';

const PAGE_SIZE_TARGET = 8192;

type OggTrackData = {
	track: OutputAudioTrack;
	serialNumber: number;
	internalSampleRate: number;
	codecInfo: OggCodecInfo;
	vorbisLastBlocksize: number | null;
	packetQueue: Packet[];
	currentTimestampInSamples: number;
	pagesWritten: number;

	currentGranulePosition: number;
	currentLacingValues: number[];
	currentPageData: Uint8Array[];
	currentPageSize: number;
	currentPageStartsWithFreshPacket: boolean;
};

type Packet = {
	data: Uint8Array;
	endGranulePosition: number;
	timestamp: number;
	forcePageFlush: boolean;
};

export class OggMuxer extends Muxer {
	private format: OggOutputFormat;
	private writer: Writer;

	private trackDatas: OggTrackData[] = [];
	private bosPagesWritten = false;
	private allTracksKnown = promiseWithResolvers();

	private pageBytes = new Uint8Array(MAX_PAGE_SIZE);
	private pageView = new DataView(this.pageBytes.buffer);

	constructor(output: Output, format: OggOutputFormat) {
		super(output);

		this.format = format;
		this.writer = output._writer;

		this.writer.ensureMonotonicity = true; // Ogg is always monotonically written!
	}

	async start() {
		// Nothin'
	}

	async getMimeType() {
		await this.allTracksKnown.promise;

		return buildOggMimeType({
			codecStrings: this.trackDatas.map(x => x.codecInfo.codec!),
		});
	}

	addEncodedVideoPacket(): never {
		throw new Error('Video tracks are not supported.');
	}

	private getTrackData(track: OutputAudioTrack, meta?: EncodedAudioChunkMetadata) {
		const existingTrackData = this.trackDatas.find(td => td.track === track);
		if (existingTrackData) {
			return existingTrackData;
		}

		// Give the track a unique random serial number
		let serialNumber: number;
		do {
			serialNumber = Math.floor(2 ** 32 * Math.random());
		} while (this.trackDatas.some(td => td.serialNumber === serialNumber));

		assert(track.source._codec === 'vorbis' || track.source._codec === 'opus');

		validateAudioChunkMetadata(meta);

		assert(meta);
		assert(meta.decoderConfig);

		const newTrackData: OggTrackData = {
			track,
			serialNumber,
			internalSampleRate: track.source._codec === 'opus'
				? OPUS_INTERNAL_SAMPLE_RATE
				: meta.decoderConfig.sampleRate,
			codecInfo: {
				codec: track.source._codec,
				vorbisInfo: null,
				opusInfo: null,
			},
			vorbisLastBlocksize: null,
			packetQueue: [],
			currentTimestampInSamples: 0,
			pagesWritten: 0,

			currentGranulePosition: 0,
			currentLacingValues: [],
			currentPageData: [],
			currentPageSize: 27,
			currentPageStartsWithFreshPacket: true,
		};

		this.queueHeaderPackets(newTrackData, meta);

		this.trackDatas.push(newTrackData);

		if (this.allTracksAreKnown()) {
			this.allTracksKnown.resolve();
		}

		return newTrackData;
	}

	private queueHeaderPackets(trackData: OggTrackData, meta: EncodedAudioChunkMetadata) {
		assert(meta.decoderConfig);

		if (trackData.track.source._codec === 'vorbis') {
			assert(meta.decoderConfig.description);

			const bytes = toUint8Array(meta.decoderConfig.description);
			if (bytes[0] !== 2) {
				throw new TypeError('First byte of Vorbis decoder description must be 2.');
			}

			let pos = 1;
			const readPacketLength = () => {
				let length = 0;

				while (true) {
					const value = bytes[pos++];
					if (value === undefined) {
						throw new TypeError('Vorbis decoder description is too short.');
					}

					length += value;

					if (value < 255) {
						return length;
					}
				}
			};

			const identificationHeaderLength = readPacketLength();
			const commentHeaderLength = readPacketLength();
			const setupHeaderLength = bytes.length - pos; // Setup header fills the remaining bytes

			if (setupHeaderLength <= 0) {
				throw new TypeError('Vorbis decoder description is too short.');
			}

			const identificationHeader = bytes.subarray(pos, pos += identificationHeaderLength);
			const commentHeader = bytes.subarray(pos, pos += commentHeaderLength);
			const setupHeader = bytes.subarray(pos);

			trackData.packetQueue.push({
				data: identificationHeader,
				endGranulePosition: 0,
				timestamp: 0,
				forcePageFlush: true,
			}, {
				data: commentHeader,
				endGranulePosition: 0,
				timestamp: 0,
				forcePageFlush: false,
			}, {
				data: setupHeader,
				endGranulePosition: 0,
				timestamp: 0,
				forcePageFlush: true, // The last header packet must flush the page
			});

			const view = toDataView(identificationHeader);
			const blockSizeByte = view.getUint8(28);

			trackData.codecInfo.vorbisInfo = {
				blocksizes: [
					1 << (blockSizeByte & 0xf),
					1 << (blockSizeByte >> 4),
				],
				modeBlockflags: parseModesFromVorbisSetupPacket(setupHeader).modeBlockflags,
			};
		} else if (trackData.track.source._codec === 'opus') {
			if (!meta.decoderConfig.description) {
				throw new TypeError('For Ogg, Opus decoder description is required.');
			}

			const identificationHeader = toUint8Array(meta.decoderConfig.description);

			const commentHeader = new Uint8Array(8 + 4 + 4);
			const view = new DataView(commentHeader.buffer);
			view.setUint32(0, 0x4f707573, false); // 'Opus'
			view.setUint32(4, 0x54616773, false); // 'Tags'
			view.setUint32(8, 0, true); // Vendor String Length
			view.setUint32(12, 0, true); // User Comment List Length

			trackData.packetQueue.push({
				data: identificationHeader,
				endGranulePosition: 0,
				timestamp: 0,
				forcePageFlush: true,
			}, {
				data: commentHeader,
				endGranulePosition: 0,
				timestamp: 0,
				forcePageFlush: true, // The last header packet must flush the page
			});

			trackData.codecInfo.opusInfo = {
				preSkip: parseOpusIdentificationHeader(identificationHeader).preSkip,
			};
		}
	}

	async addEncodedAudioPacket(track: OutputAudioTrack, packet: EncodedPacket, meta?: EncodedAudioChunkMetadata) {
		const release = await this.mutex.acquire();

		try {
			const trackData = this.getTrackData(track, meta);

			this.validateAndNormalizeTimestamp(trackData.track, packet.timestamp, packet.type === 'key');

			const currentTimestampInSamples = trackData.currentTimestampInSamples;

			const { durationInSamples, vorbisBlockSize } = extractSampleMetadata(
				packet.data,
				trackData.codecInfo,
				trackData.vorbisLastBlocksize,
			);
			trackData.currentTimestampInSamples += durationInSamples;
			trackData.vorbisLastBlocksize = vorbisBlockSize;

			trackData.packetQueue.push({
				data: packet.data,
				endGranulePosition: trackData.currentTimestampInSamples,
				timestamp: currentTimestampInSamples / trackData.internalSampleRate,
				forcePageFlush: false,
			});

			await this.interleavePages();
		} finally {
			release();
		}
	}

	addSubtitleCue(): never {
		throw new Error('Subtitle tracks are not supported.');
	}

	allTracksAreKnown() {
		for (const track of this.output._tracks) {
			if (!track.source._closed && !this.trackDatas.some(x => x.track === track)) {
				return false; // We haven't seen a sample from this open track yet
			}
		}

		return true;
	}

	async interleavePages(isFinalCall = false) {
		if (!this.bosPagesWritten) {
			if (!this.allTracksAreKnown()) {
				return; // We can't interleave yet as we don't yet know how many tracks we'll truly have
			}

			// Write the header page for all bitstreams
			for (const trackData of this.trackDatas) {
				while (trackData.packetQueue.length > 0) {
					const packet = trackData.packetQueue.shift()!;
					this.writePacket(trackData, packet, false);

					if (packet.forcePageFlush) {
						// We say the header page ends once the first packet is encountered that forces a page flush
						break;
					}
				}
			}

			this.bosPagesWritten = true;
		}

		outer:
		while (true) {
			let trackWithMinTimestamp: OggTrackData | null = null;
			let minTimestamp = Infinity;

			for (const trackData of this.trackDatas) {
				if (
					!isFinalCall
					&& trackData.packetQueue.length <= 1 // Limit is 1, not 0, for correct EOS flag logic
					&& !trackData.track.source._closed
				) {
					break outer;
				}

				if (
					trackData.packetQueue.length > 0
					&& trackData.packetQueue[0]!.timestamp < minTimestamp
				) {
					trackWithMinTimestamp = trackData;
					minTimestamp = trackData.packetQueue[0]!.timestamp;
				}
			}

			if (!trackWithMinTimestamp) {
				break;
			}

			const packet = trackWithMinTimestamp.packetQueue.shift()!;
			const isFinalPacket = trackWithMinTimestamp.packetQueue.length === 0;

			this.writePacket(trackWithMinTimestamp, packet, isFinalPacket);
		}

		if (!isFinalCall) {
			await this.writer.flush();
		}
	}

	writePacket(trackData: OggTrackData, packet: Packet, isFinalPacket: boolean) {
		let remainingLength = packet.data.length;
		let dataStartOffset = 0;
		let dataOffset = 0;

		while (true) {
			if (trackData.currentLacingValues.length === 0 && dataStartOffset > 0) {
				// This is a packet spanning multiple pages
				trackData.currentPageStartsWithFreshPacket = false;
			}

			const segmentSize = Math.min(255, remainingLength);
			trackData.currentLacingValues.push(segmentSize);
			trackData.currentPageSize++;
			dataOffset += segmentSize;

			const segmentIsLastOfPacket = remainingLength < 255;

			if (trackData.currentLacingValues.length === 255) {
				// The page is full, we need to add part of the packet data and then flush the page
				const slice = packet.data.subarray(dataStartOffset, dataOffset);
				dataStartOffset = dataOffset;
				trackData.currentPageData.push(slice);
				trackData.currentPageSize += slice.length;

				this.writePage(trackData, isFinalPacket && segmentIsLastOfPacket);

				if (segmentIsLastOfPacket) {
					return;
				}
			}

			if (segmentIsLastOfPacket) {
				break;
			}
			remainingLength -= 255;
		}

		const slice = packet.data.subarray(dataStartOffset);
		trackData.currentPageData.push(slice);
		trackData.currentPageSize += slice.length;
		trackData.currentGranulePosition = packet.endGranulePosition;

		if (trackData.currentPageSize >= PAGE_SIZE_TARGET || packet.forcePageFlush) {
			this.writePage(trackData, isFinalPacket);
		}
	}

	writePage(trackData: OggTrackData, isEos: boolean) {
		this.pageView.setUint32(0, OGGS, true); // Capture pattern
		this.pageView.setUint8(4, 0); // Version

		let headerType = 0;
		if (!trackData.currentPageStartsWithFreshPacket) {
			headerType |= 1;
		}
		if (trackData.pagesWritten === 0) {
			headerType |= 2; // Beginning of stream
		}
		if (isEos) {
			headerType |= 4; // End of stream
		}
		this.pageView.setUint8(5, headerType); // Header type

		const granulePosition = trackData.currentLacingValues.every(x => x === 255)
			? -1 // No packets end on this page
			: trackData.currentGranulePosition;
		setInt64(this.pageView, 6, granulePosition, true); // Granule position

		this.pageView.setUint32(14, trackData.serialNumber, true); // Serial number
		this.pageView.setUint32(18, trackData.pagesWritten, true); // Page sequence number
		this.pageView.setUint32(22, 0, true); // Checksum placeholder

		this.pageView.setUint8(26, trackData.currentLacingValues.length); // Number of page segments
		this.pageBytes.set(trackData.currentLacingValues, 27);

		let pos = 27 + trackData.currentLacingValues.length;
		for (const data of trackData.currentPageData) {
			this.pageBytes.set(data, pos);
			pos += data.length;
		}

		const slice = this.pageBytes.subarray(0, pos);

		const crc = computeOggPageCrc(slice);
		this.pageView.setUint32(22, crc, true); // Checksum

		trackData.pagesWritten++;
		trackData.currentLacingValues.length = 0;
		trackData.currentPageData.length = 0;
		trackData.currentPageSize = 27;
		trackData.currentPageStartsWithFreshPacket = true;

		if (this.format._options.onPage) {
			this.writer.startTrackingWrites();
		}

		this.writer.write(slice);

		if (this.format._options.onPage) {
			const { data, start } = this.writer.stopTrackingWrites();
			this.format._options.onPage(data, start, trackData.track.source);
		}
	}

	// eslint-disable-next-line @typescript-eslint/no-misused-promises
	override async onTrackClose() {
		const release = await this.mutex.acquire();

		if (this.allTracksAreKnown()) {
			this.allTracksKnown.resolve();
		}

		// Since a track is now closed, we may be able to write out chunks that were previously waiting
		await this.interleavePages();

		release();
	}

	async finalize() {
		const release = await this.mutex.acquire();

		this.allTracksKnown.resolve();

		await this.interleavePages(true);

		for (const trackData of this.trackDatas) {
			if (trackData.currentLacingValues.length > 0) {
				this.writePage(trackData, true);
			}
		}

		release();
	}
}

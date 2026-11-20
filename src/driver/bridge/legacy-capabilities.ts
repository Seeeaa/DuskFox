import type { BridgeStatusPayload } from './contract.ts';
import type { Capabilities, DownloadCapabilities, SegmentKind } from '../types.ts';
import { capabilityMap, downloadCapabilities, segmentCapabilities } from '../types.ts';

const SEGMENT_FEATURE: Record<SegmentKind, string | null> = {
  text: null, at: null, reply: null, face: null, json: null, markdown: null,
  image: 'mediaImage', record: 'mediaRecord', video: 'mediaVideo', file: 'mediaFile', forward: 'mediaForward',
};

/** v1/v2 only. Remove after deployed runtimes all report complete v3 capabilities. */
export function readLegacyCapabilities(payload: BridgeStatusPayload): Capabilities {
  if (Number(payload.contract ?? 1) < 2) return capabilityMap({ privateMessage: true, qrLogin: true });
  const features = payload.features ?? {};
  const directions = (list: readonly string[]) => segmentCapabilities(list.filter((kind): kind is SegmentKind => {
    if (!(kind in SEGMENT_FEATURE)) return false;
    const feature = SEGMENT_FEATURE[kind as SegmentKind];
    return feature === null || features[feature] === true;
  }));
  const send = directions(payload.send_segments ?? ['text']);
  const recv = directions(payload.recv_segments ?? ['text']);
  const downloads = (payload.download_segments ?? []).filter((kind): kind is keyof DownloadCapabilities =>
    kind === 'image' || kind === 'record' || kind === 'file' || kind === 'video' || kind === 'forward');
  const values: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(features)) if (typeof value === 'boolean') values[key] = value;
  return capabilityMap({
    ...values, send, recv, download: downloadCapabilities(downloads),
    privateMessage: features.privateMessage === true && send.text,
    groupMessage: features.groupMessage === true && send.text, qrLogin: true
  });
}

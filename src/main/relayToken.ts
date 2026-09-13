// src/main/relayToken.ts — 混合口令（tconf_v1）解码桥。
// 实现与中继侧共用同一份零依赖源码（relay/src/token.mjs），
// webpack 直接内联打包（仅依赖 node:zlib / node:crypto）。
// @ts-expect-error — 共享 .mjs 无类型声明（接口在本文件手工镜像）
import { decodeAccessToken, caFingerprint } from '../../relay/src/token.mjs';

export interface RelayTokenConfig {
  v: 1;
  url: string;
  master: string;
  ca: string;
  e2ee: boolean;
  label: string;
  iat: number;
}

export type RelayTokenResult =
  | { ok: true; config: RelayTokenConfig }
  | { ok: false; error: string };

export async function decodeRelayToken(raw: string): Promise<RelayTokenResult> {
  return (await decodeAccessToken(raw)) as RelayTokenResult;
}

export function relayCaFingerprint(pem: string): string | null {
  return caFingerprint(pem);
}

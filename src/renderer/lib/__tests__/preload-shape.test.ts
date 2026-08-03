import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// v0.18.19 patch R34 P2: preload contextBridge 노출 surface 의 drift 가드.
//
// `src/preload/index.ts` 는 electron 의 `contextBridge`/`ipcRenderer` 를 import 하므로
// vitest 의 node 환경에서 직접 import 불가. 대신 source 텍스트를 정적으로 읽어 노출되는
// 키 집합 + IPC channel 이름이 기대값과 일치함을 검증한다 (snapshot 식 가드).
//
// 발견되는 결함:
//   1. IPC channel 이름 drift (예: preload 가 `ai:ocr-page` 를 호출하는데 main 이
//      `ai:ocrPage` 로 핸들러 등록) — 본 테스트는 preload 측 channel 이름만 검사
//   2. 노출 surface 추가/제거 — `electronAPI` 의 top-level 키 집합 변경
//   3. 함수 시그니처 변경 — 인자 개수 (정규식 기반 spot check)
//
// 한계: main process 의 핸들러 채널과 cross-check 는 본 테스트 범위 밖.

// R45 fix: CRLF 정규화 — Windows CI 체크아웃(autocrlf)은 줄당 +1자라 아래 길이 제한 윈도
// 매칭이 OS 에 따라 갈렸다 (windows-2025 잡만 실패, ubuntu/로컬 LF 는 통과하던 비결정성 제거).
const PRELOAD_SRC = readFileSync(
  resolve(import.meta.dirname, '../../../preload/index.ts'),
  'utf-8',
).replace(/\r\n/g, '\n');

describe('preload contextBridge shape (R34 P2)', () => {
  it('expose target 은 정확히 `electronAPI` 라는 이름이어야 한다', () => {
    expect(PRELOAD_SRC).toMatch(/exposeInMainWorld\(['"]electronAPI['"]/);
  });

  it('top-level 키 집합 — ollama / ai / file / settings / apiKey / update / openExternal / onSetupProgress / onFileDropped', () => {
    const expectedTopKeys = [
      'ollama:', 'ai:', 'file:', 'settings:', 'apiKey:', 'update:',
      'openExternal:', 'onSetupProgress:', 'onFileDropped:', 'getPathForFile:',
    ];
    for (const key of expectedTopKeys) {
      expect(PRELOAD_SRC).toContain(`  ${key}`);
    }
  });

  // (은퇴, post-v0.24.4 QA) 기존 "모든 known channel 존재" 손유지 리스트는 stale 해져
  // ~12채널(file:open-path, session:list/delete/clear/stats, collections:*)이 빠진 채 green
  // 이었다. 채널 완전성 + preload↔main 일치는 이제 자가유지 cross-side 계약 테스트
  // (src/main/__tests__/ipc-channel-contract.test.ts)가 소스 추출로 소유한다. 본 파일은
  // surface-key / 함수 시그니처 / unsubscribe 같은 preload-국소 가드만 유지한다.

  it('ai.ocrPage 시그니처는 (imageBase64, requestId?) — R32 P2 OCR cloud abort 회귀 가드', () => {
    // R32 P2 가 ocrPage 에 requestId 인자를 추가했음. drift 되면 OCR abort 가 다시 무력화됨.
    expect(PRELOAD_SRC).toMatch(/ocrPage:\s*\(imageBase64:\s*string,\s*requestId\?:\s*string\)/);
    expect(PRELOAD_SRC).toMatch(/ipcRenderer\.invoke\(\s*['"]ai:ocr-page['"],\s*imageBase64,\s*requestId\s*\)/);
  });

  it('ai.embed 시그니처는 (texts, requestId?) — R29 회귀 가드', () => {
    expect(PRELOAD_SRC).toMatch(/embed:\s*\(texts:\s*string\[\],\s*requestId\?:\s*string\)/);
  });

  it('ai.analyzeImage 시그니처는 (imageBase64, requestId?) — R30 P2 회귀 가드', () => {
    expect(PRELOAD_SRC).toMatch(/analyzeImage:\s*\(imageBase64:\s*string,\s*requestId\?:\s*string\)/);
  });

  it('openExternal 은 https:// prefix 가드 + invoke 직접 wiring 유지', () => {
    // R28 P2 에 도입된 renderer-side 가드 — main 까지 도달 전에 차단
    expect(PRELOAD_SRC).toMatch(/openExternal:\s*\(url:\s*string\)\s*=>\s*{[\s\S]*?startsWith\(['"]https:\/\/['"]\)/);
  });

  it('ElectronAPI 타입이 source 마지막에 export 되어 renderer 가 참조 가능', () => {
    expect(PRELOAD_SRC).toMatch(/export type ElectronAPI/);
  });

  it('declare global 로 Window.electronAPI 타입 확장', () => {
    expect(PRELOAD_SRC).toMatch(/declare global/);
    expect(PRELOAD_SRC).toMatch(/interface Window\s*{/);
    expect(PRELOAD_SRC).toMatch(/electronAPI:\s*ElectronAPI/);
  });

  it('on* listeners 모두 unsubscribe 함수 반환 (memory leak 가드)', () => {
    // QA22(D-MED): 이전 구현은 `${name}:[\s\S]{0,600}?removeListener` 였는데, **600자 윈도가 다음
    // 함수까지 넘어가** onToken 의 removeListener 를 지워도 ~450자 뒤 onDone 의 것에 매칭됐다.
    // 뮤테이션 실증: onToken 만 감지 실패(무증상 통과), 나머지 4개는 감지. 하필 앱에서 가장 빈번한
    // 리스너(ai:token — 스트리밍 토큰마다)의 구독 해제 누락을 "memory leak 가드" 가 못 잡았다.
    // → **다음 on* 프로퍼티가 나오기 전까지**로 윈도를 좁혀 블록 경계를 넘지 못하게 한다.
    // onFlushBeforeQuit 도 추가 — QA10/16/17/18/20 에서 반복해 깨진 종료 flush 핸드셰이크의
    // 구독 경로인데 목록에서 통째로 빠져 있었다.
    const onPatterns = ['onToken', 'onDone', 'onSetupProgress', 'onFileDropped', 'onStatus', 'onFlushBeforeQuit'];
    for (const name of onPatterns) {
      const escaped = name.replace(/\$/g, '\\$');
      // `name:` 부터 **다음 `onXxx:` 프로퍼티 직전까지**만 본다(= 이 리스너의 블록).
      const block = PRELOAD_SRC.match(new RegExp(`${escaped}:(?:(?!\\bon[A-Z]\\w*:)[\\s\\S])*?removeListener`));
      expect(block, `${name} 에서 removeListener 가 보이지 않음 — memory leak 회귀 가능`).not.toBeNull();
    }
  });
});

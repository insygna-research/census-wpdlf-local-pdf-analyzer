import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { selectUpdateBanner, shouldResetDismiss, type UpdateBanner } from '../update-banner';
import type { UpdateState, UpdateStatus } from '../../../shared/update-types';

/**
 * 메인 화면 업데이트 배너 판정 회귀 넷.
 *
 * 배경: 배너가 'downloaded' 일 때만 떴는데 다운로드는 사용자 승인이 있어야 시작되므로,
 * **새 버전이 나왔다는 사실을 설정 화면을 열어야만 알 수 있었다** — 자동 업데이트가 켜져 있어도
 * 설정에 들어가지 않는 사용자는 계속 구버전에 머문다. 세 단계를 모두 표면화하되, 다운로드/설치
 * 승인 정책과 "닫아두면 조용해야 한다"는 성질은 그대로 지킨다.
 */

const state = (status: UpdateStatus, over: Partial<UpdateState> = {}): UpdateState => ({
  status,
  currentVersion: '0.31.38',
  newVersion: status === 'available' || status === 'downloading' || status === 'downloaded' ? '0.31.39' : null,
  percent: 0,
  errorKey: null,
  ...over,
});

describe('selectUpdateBanner — 어떤 상태에서 배너를 띄우는가', () => {
  it('available: 새 버전 알림(다운로드 승인 대기)', () => {
    expect(selectUpdateBanner(state('available'))).toEqual({ kind: 'available', version: '0.31.39' });
  });

  it('downloading: 진행률 알림', () => {
    expect(selectUpdateBanner(state('downloading', { percent: 42 }))).toEqual({ kind: 'downloading', percent: 42 });
  });

  it('downloaded: 설치 준비 알림(종전 동작 보존)', () => {
    expect(selectUpdateBanner(state('downloaded'))).toEqual({ kind: 'downloaded', version: '0.31.39' });
  });

  // 아래 상태들에서 배너가 뜨면 매 기동 깜빡이거나(checking) 요청하지 않은 실패로 화면을
  // 어지럽힌다(error). 설정 패널이 담당하는 영역.
  it.each<UpdateStatus>(['unsupported', 'idle', 'checking', 'not-available', 'error'])(
    '%s 는 배너를 띄우지 않는다',
    (status) => {
      expect(selectUpdateBanner(state(status))).toBeNull();
    },
  );

  it('상태가 없으면(초기 조회 실패 등) 배너 없음', () => {
    expect(selectUpdateBanner(null)).toBeNull();
    expect(selectUpdateBanner(undefined)).toBeNull();
  });

  it('버전 문자열이 비어도 배너는 뜬다 — 문구만 폴백하도록 null 로 정규화 (QA19 정책)', () => {
    expect(selectUpdateBanner(state('available', { newVersion: '' }))).toEqual({ kind: 'available', version: null });
    expect(selectUpdateBanner(state('downloaded', { newVersion: null }))).toEqual({ kind: 'downloaded', version: null });
  });

  it('진행률은 0~100 정수로 정규화한다 (피드/이벤트 이상값 방어)', () => {
    expect(selectUpdateBanner(state('downloading', { percent: -5 }))).toEqual({ kind: 'downloading', percent: 0 });
    expect(selectUpdateBanner(state('downloading', { percent: 150 }))).toEqual({ kind: 'downloading', percent: 100 });
    expect(selectUpdateBanner(state('downloading', { percent: 42.6 }))).toEqual({ kind: 'downloading', percent: 43 });
    expect(selectUpdateBanner(state('downloading', { percent: NaN }))).toEqual({ kind: 'downloading', percent: 0 });
  });
});

// 배선 가드: 순수 판정이 맞아도 App 이 그것을 쓰지 않으면 사용자에게는 아무 변화가 없다.
// App.tsx 는 앱 전체를 끌고 들어와 행위 테스트 하네스가 없으므로(다른 렌더러 컴포넌트와 달리),
// preload-shape.test 와 같은 **정적 소스 스캔**으로 최소 계약만 못박는다.
describe('App 배선 가드', () => {
  const APP_SRC = readFileSync(resolve(import.meta.dirname, '../../App.tsx'), 'utf-8');

  it('App 이 배너 판정을 이 모듈에 위임한다', () => {
    expect(APP_SRC).toMatch(/selectUpdateBanner\(/);
    expect(APP_SRC).toMatch(/shouldResetDismiss\(/);
  });

  it("available 배너에 다운로드 조작이 붙어 있다 (알림만 뜨고 진행할 수 없으면 의미가 없다)", () => {
    expect(APP_SRC).toMatch(/update\.download\(\)/);
    expect(APP_SRC).toMatch(/update\.install\(\)/);
  });

  it('설치 버튼만 작업 중 게이트(updateInstallBusy)를 쓴다 — 다운로드는 앱을 종료시키지 않는다', () => {
    // 다운로드 버튼에 게이트가 붙으면 요약 중인 사용자는 업데이트를 받아둘 수조차 없다.
    const installBlock = /update\.install\(\)[\s\S]{0,600}?disabled=\{updateInstallBusy\}/;
    expect(APP_SRC).toMatch(installBlock);
    const downloadBlock = /update\.download\(\)[\s\S]{0,400}?<\/button>/.exec(APP_SRC)?.[0] ?? '';
    expect(downloadBlock).not.toMatch(/disabled=/);
  });
});

describe('shouldResetDismiss — 닫아둔 배너를 다시 띄울 때', () => {
  const avail: UpdateBanner = { kind: 'available', version: '0.31.39' };

  it('같은 단계의 반복 브로드캐스트로는 되살아나지 않는다 (닫으면 조용해야 한다)', () => {
    expect(shouldResetDismiss(avail, { kind: 'available', version: '0.31.39' })).toBe(false);
  });

  it('진행률만 바뀌는 downloading 반복도 되살리지 않는다', () => {
    expect(shouldResetDismiss({ kind: 'downloading', percent: 10 }, { kind: 'downloading', percent: 90 })).toBe(false);
  });

  it('단계가 바뀌면 다시 띄운다 — available 을 닫은 것이 설치 준비 알림까지 버린다는 뜻은 아니다', () => {
    expect(shouldResetDismiss(avail, { kind: 'downloaded', version: '0.31.39' })).toBe(true);
    expect(shouldResetDismiss(avail, { kind: 'downloading', percent: 1 })).toBe(true);
  });

  it('같은 단계라도 새 버전이면 다시 띄운다 (이전 버전의 닫기가 다음 알림을 삼키지 않게)', () => {
    expect(shouldResetDismiss(avail, { kind: 'available', version: '0.31.40' })).toBe(true);
  });

  it('배너가 없다가 생기면 띄운다 / 사라지는 전이는 해제하지 않는다', () => {
    expect(shouldResetDismiss(null, avail)).toBe(true);
    expect(shouldResetDismiss(avail, null)).toBe(false);
  });
});

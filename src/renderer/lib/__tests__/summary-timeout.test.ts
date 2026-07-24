import { describe, it, expect } from 'vitest';
import { isSummaryTimedOut } from '../use-summarize';

// QA19(B-MED): 요약 완주 타임아웃 판정. 기존 5분 단일 총상한이 정상 대형 문서(500p≈31분)를
// 죽이던 것을 무진전+백스톱으로 바꾼 핵심 로직 — 감시견과 루프 폴링이 공유한다.

const IDLE = 120_000;                 // 2분 무진전
const MAX = 3 * 60 * 60 * 1000;       // 3시간 백스톱

describe('isSummaryTimedOut', () => {
  it('핵심 회귀 방어: 총 경과가 옛 5분 상한을 넘어도 최근 진전이 있으면 완주한다', () => {
    const start = 0;
    const now = 40 * 60 * 1000;        // 40분 경과(옛 상한 5분을 한참 초과)
    const lastProgress = now - 3_000;  // 3초 전 토큰 수신
    expect(isSummaryTimedOut(now, start, lastProgress, IDLE, MAX)).toBe(false);
  });

  it('무진전이 idle 상한을 넘으면 중단한다', () => {
    const start = 0;
    const now = 10 * 60 * 1000;
    const lastProgress = now - (IDLE + 1);
    expect(isSummaryTimedOut(now, start, lastProgress, IDLE, MAX)).toBe(true);
  });

  it('무진전이 idle 경계 이내면 유지한다(off-by-one)', () => {
    const now = 10 * 60 * 1000;
    expect(isSummaryTimedOut(now, 0, now - IDLE, IDLE, MAX)).toBe(false);       // 정확히 경계 = 유지
    expect(isSummaryTimedOut(now, 0, now - IDLE - 1, IDLE, MAX)).toBe(true);    // 1ms 초과 = 중단
  });

  it('절대 백스톱: 진전이 계속 있어도 총 경과가 maxTotal 을 넘으면 중단한다(폭주 방어)', () => {
    const now = MAX + 1;
    const lastProgress = now - 100;    // 방금도 진전 있음
    expect(isSummaryTimedOut(now, 0, lastProgress, IDLE, MAX)).toBe(true);
  });

  it('백스톱 경계 이내면 유지한다', () => {
    expect(isSummaryTimedOut(MAX, 0, MAX, IDLE, MAX)).toBe(false);              // 정확히 경계 = 유지
    expect(isSummaryTimedOut(MAX + 1, 0, MAX + 1, IDLE, MAX)).toBe(true);       // 1ms 초과 = 중단
  });

  it('요약 시작 직후(진전 전)에는 중단하지 않는다', () => {
    expect(isSummaryTimedOut(0, 0, 0, IDLE, MAX)).toBe(false);
  });

  // QA20(A-MED, v0.31.31 회귀 재발 방지): 이미지 분석 단계는 토큰을 한 글자도 append 하지 않고
  // 진행률만 갱신한다. 진전 신호를 토큰에만 두면 이 구간 전체가 무진전으로 오판돼, 기본 설정
  // (이미지 분석 ON)에서 정상 요약이 2분에 죽었다. "진행률 갱신 = 진전"이라는 계약을 고정한다.
  it('이미지 분석처럼 토큰 없이 진행률만 갱신되는 구간도 진전으로 인정돼야 한다', () => {
    const start = 0;
    // 이미지 배치가 90초 간격으로 진행률만 갱신하며 6분간 지속되는 상황
    let lastProgress = start;
    for (const now of [90_000, 180_000, 270_000, 360_000]) {
      // 각 시점 직전에 진행률 갱신이 있었다면(=lastProgress 가 따라온다) 중단되지 않는다
      expect(isSummaryTimedOut(now, start, lastProgress, IDLE, MAX)).toBe(false);
      lastProgress = now; // 진행률 갱신 = 진전 신호
    }
  });

  it('진행률 갱신이 idle 상한을 넘어 끊기면 그때는 중단한다(진짜 정지 감지는 유지)', () => {
    const start = 0;
    const lastProgress = 90_000;                 // 마지막 진행률 갱신
    const now = lastProgress + IDLE + 1;         // 그 뒤로 2분 넘게 아무 진전 없음
    expect(isSummaryTimedOut(now, start, lastProgress, IDLE, MAX)).toBe(true);
  });
});

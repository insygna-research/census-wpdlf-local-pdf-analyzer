import { describe, it, expect } from 'vitest';
import { assemblePageText, type TextItemLike } from '../pdf-parser';

/**
 * 페이지 텍스트 조립기(assemblePageText) 회귀 넷.
 *
 * 이 로직은 추출 품질의 뿌리 — 요약·인용·검색·RAG 가 전부 이 문자열을 본다 — 인데도 parsePdf 의
 * 배치 루프 안에 인라인이라 **테스트가 한 건도 없었다**. QA22 가 회전 텍스트 fontSize 결함을
 * "그 루프에 테스트 0건이라 위험" 으로 보류한 지점이라, 수정 전에 기존 동작부터 고정한다.
 *
 * 픽스처 규약: 텍스트 행렬 tx = [a, b, c, d, e, f] (e=x, f=y). 글자 크기 s, 회전 θ 이면
 * [s·cosθ, s·sinθ, -s·sinθ, s·cosθ].
 */

/** 회전 없는 아이템 — 크기 s, 위치 (x, y). */
const it0 = (str: string, s: number, x: number, y: number, width?: number): TextItemLike => ({
  str, transform: [s, 0, 0, s, x, y], ...(width !== undefined ? { width } : {}),
});
/** 90° 회전 아이템 — a=d=0, 크기는 b·c 에 들어간다(결함이 있던 형태). */
const it90 = (str: string, s: number, x: number, y: number, width?: number): TextItemLike => ({
  str, transform: [0, s, -s, 0, x, y], ...(width !== undefined ? { width } : {}),
});

describe('assemblePageText — 기존 동작 고정(회귀 넷)', () => {
  it('같은 줄에서 간격이 좁으면 공백 없이 붙인다 (한글 글자 단위 분할 복원)', () => {
    // pdfjs 가 '안','녕' 을 개별 아이템으로 주는 전형적 한글 케이스 — 폭만큼만 전진.
    const items = [it0('안', 10, 0, 700, 10), it0('녕', 10, 10, 700, 10)];
    expect(assemblePageText(items)).toBe('안녕');
  });

  it('같은 줄에서 간격이 크면 공백을 넣는다', () => {
    // 두 번째 아이템 x=30 > lastEndX(10) + 0.3×10=3 → 공백
    const items = [it0('A', 10, 0, 700, 10), it0('B', 10, 30, 700, 10)];
    expect(assemblePageText(items)).toBe('A B');
  });

  it('y 가 글자 크기의 절반을 넘게 바뀌면 줄바꿈', () => {
    const items = [it0('첫줄', 10, 0, 700, 20), it0('둘째줄', 10, 0, 680, 30)];
    expect(assemblePageText(items)).toBe('첫줄\n둘째줄');
  });

  it('y 변화가 임계 이하면 같은 줄로 본다 (베이스라인 미세 흔들림 흡수)', () => {
    const items = [it0('가', 10, 0, 700, 10), it0('나', 10, 10, 697, 10)];
    expect(assemblePageText(items)).toBe('가나');
  });

  it('transform 이 없는 아이템은 공백으로 이어 붙인다', () => {
    const items: TextItemLike[] = [{ str: 'A' }, { str: 'B' }];
    expect(assemblePageText(items)).toBe('A B');
  });

  it('첫 아이템이 transform 없으면 선행 공백을 만들지 않는다', () => {
    expect(assemblePageText([{ str: 'A' }])).toBe('A');
  });

  it('빈 문자열·str 없는 항목(TextMarkedContent 등)은 건너뛴다', () => {
    const items: unknown[] = [{ type: 'beginMarkedContent' }, it0('A', 10, 0, 700, 10), { str: '' }];
    expect(assemblePageText(items)).toBe('A');
  });

  it('width 가 없으면 글자 수 × 크기의 절반으로 폭을 추정한다', () => {
    // 'AB' 폭 추정 = 2 × 10 × 0.5 = 10 → lastEndX=10. 다음 x=12 는 10+3=13 이하라 공백 없음.
    expect(assemblePageText([it0('AB', 10, 0, 700), it0('C', 10, 12, 700)])).toBe('ABC');
    // x=20 이면 13 초과 → 공백
    expect(assemblePageText([it0('AB', 10, 0, 700), it0('C', 10, 20, 700)])).toBe('AB C');
  });

  it('빈 items 는 빈 문자열', () => {
    expect(assemblePageText([])).toBe('');
  });
});

describe('assemblePageText — 회전 텍스트 크기 판정 (QA22 백로그)', () => {
  // 이전 구현은 `|a| || |d| || 12` 라 90° 회전(a=d=0)에서 **항상 12** 로 폴백했다.
  // 세로 축 라벨·측면 표·워터마크가 흔한 논문/도면 PDF 에서 임계가 실제 크기와 어긋난다.

  it('큰 글자(30)의 90° 회전: 12 폴백이면 생기던 과다 줄바꿈이 없다', () => {
    // y 간격 14 — 실제 크기 30 기준 임계 15 이하라 같은 줄, 옛 폴백 12 기준 임계 6 이면 줄바꿈.
    const items = [it90('세', 30, 100, 700, 30), it90('로', 30, 100, 686, 30)];
    expect(assemblePageText(items)).toBe('세로');
  });

  it('작은 글자(6)의 90° 회전: 12 폴백이면 붙어버리던 줄이 분리된다', () => {
    // y 간격 4 — 실제 크기 6 기준 임계 3 초과라 줄바꿈, 옛 폴백 12 기준 임계 6 이면 같은 줄.
    const items = [it90('A', 6, 100, 700, 6), it90('B', 6, 100, 696, 6)];
    expect(assemblePageText(items)).toBe('A\nB');
  });

  it('270° 회전(부호 반대)도 동일하게 실제 크기를 얻는다', () => {
    const items: TextItemLike[] = [
      { str: '세', transform: [0, -30, 30, 0, 100, 700], width: 30 },
      { str: '로', transform: [0, -30, 30, 0, 100, 686], width: 30 },
    ];
    expect(assemblePageText(items)).toBe('세로');
  });

  it('임의 각도(45°)도 회전 전 크기를 복원한다', () => {
    // s=20, θ=45° → a=b=14.142. 옛 구현은 a(14.142)를 써 크기를 과소평가했다.
    const s = 20, k = s * Math.SQRT1_2;
    const items: TextItemLike[] = [
      { str: '기', transform: [k, k, -k, k, 0, 700], width: 20 },
      { str: '울', transform: [k, k, -k, k, 14, 691], width: 20 }, // y 간격 9 < 20×0.5 → 같은 줄
    ];
    expect(assemblePageText(items)).toBe('기울');
  });

  it('회전 없는 일반 텍스트의 크기 판정은 종전과 동일하다 (동작 보존)', () => {
    // hypot(s,0) === |s| — 이 등가성이 깨지면 전 문서의 줄바꿈/공백이 흔들린다.
    const items = [it0('첫줄', 10, 0, 700, 20), it0('둘째줄', 10, 0, 694, 30)]; // 간격 6 > 5 → 줄바꿈
    expect(assemblePageText(items)).toBe('첫줄\n둘째줄');
  });

  it('a·b 가 모두 0 인 퇴화 행렬은 d 로, 그것도 0 이면 12 로 폴백', () => {
    // d=8 사용 → 임계 4, y 간격 5 → 줄바꿈
    const byD: TextItemLike[] = [
      { str: 'A', transform: [0, 0, 0, 8, 0, 700], width: 8 },
      { str: 'B', transform: [0, 0, 0, 8, 0, 695], width: 8 },
    ];
    expect(assemblePageText(byD)).toBe('A\nB');
    // 전부 0 → 12 폴백 → 임계 6, y 간격 5 → 같은 줄
    const allZero: TextItemLike[] = [
      { str: 'A', transform: [0, 0, 0, 0, 0, 700], width: 0 },
      { str: 'B', transform: [0, 0, 0, 0, 0, 695], width: 0 },
    ];
    expect(assemblePageText(allZero)).toBe('AB');
  });
});

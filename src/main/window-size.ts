/**
 * 기본 창 크기 산출 — 순수 함수(화면 작업영역 → 창 크기).
 *
 * 이전에는 `width: 1000, height: 1200` 하드코딩이었다. 두 가지 문제가 있었다:
 *  1. 큰 화면에서 너무 작다 — 이 앱의 주 화면은 요약과 PDF 뷰어를 좌우로 나눠 쓰는 2단 구성인데
 *     (인용 클릭 → 우측 뷰어), 1000px 는 2560px 모니터에서 화면의 39% 다. 분할 후 각 패널이
 *     좁아 원문 확인이라는 핵심 용도가 불편해진다.
 *  2. 작은 화면에서 **화면 밖으로 나간다** — height 1200 은 1080p 의 작업영역(≈1040px)과
 *     노트북 1536×864(작업영역 816px)를 넘는다. Electron 은 자동으로 줄여주지 않으므로 창
 *     아래쪽(요약 본문·입력창)이 잘린 채 뜬다.
 *
 * 그래서 고정값 대신 **작업영역 비율 + 상·하한**으로 정한다. 작업영역(workArea)은 작업표시줄을
 * 제외한 영역이라 이 값을 넘지 않으면 항상 화면 안에 들어온다.
 */

/** 창이 이보다 작으면 UI 가 깨진다 — BrowserWindow 의 minWidth/minHeight 와 같은 값. */
export const MIN_WINDOW_WIDTH = 700;
export const MIN_WINDOW_HEIGHT = 600;

/**
 * 상한 — 초대형/울트라와이드 모니터에서 창이 화면을 가득 채우면 오히려 쓰기 불편하고(텍스트 행이
 * 지나치게 길어진다) 다른 창과 병행 작업이 어렵다. 최대화는 사용자가 직접 하면 된다.
 */
export const MAX_DEFAULT_WIDTH = 1600;
export const MAX_DEFAULT_HEIGHT = 1400;

/**
 * 작업영역 대비 비율. 세로를 크게 두는 이유: 문서 뷰어라 **세로 공간이 곧 한 번에 읽는 양**이다
 * (요약 본문·PDF 페이지·Q&A 스레드가 전부 세로로 흐른다). 폭은 텍스트 행 길이와 병행 작업 때문에
 * 오히려 제한하는 편이 낫지만, 높이는 화면이 허용하는 만큼 쓰는 게 이득이라 비율·상한을 함께 올렸다.
 * 상단 여백(0.92)은 창을 옮기거나 작업표시줄이 자동 숨김 해제될 때의 여유다.
 */
export const WIDTH_RATIO = 0.7;
export const HEIGHT_RATIO = 0.92;

export interface WindowSize {
  width: number;
  height: number;
}

/**
 * 기본 창 크기.
 *
 * 규칙: `min(상한, max(하한, 작업영역 × 비율))` — 단 **작업영역을 절대 넘지 않는다**(하한이
 * 작업영역보다 큰 초소형 화면에서는 작업영역에 맞춘다. 이때는 minWidth/minHeight 가 창을 다시
 * 키울 수 있지만, 그건 Electron 의 제약이고 여기서 화면 밖 크기를 *의도적으로* 주지는 않는다).
 * 작업영역 값이 없거나 비정상(0·음수·NaN)이면 이전 동작과 가까운 안전 기본값으로 폴백한다.
 */
export function computeDefaultWindowSize(workArea?: Partial<WindowSize> | null): WindowSize {
  const areaW = normalize(workArea?.width);
  const areaH = normalize(workArea?.height);
  if (areaW === null || areaH === null) {
    return { width: 1200, height: 900 }; // 화면 정보를 못 얻은 경우의 무난한 기본값
  }
  return {
    width: fit(areaW, WIDTH_RATIO, MIN_WINDOW_WIDTH, MAX_DEFAULT_WIDTH),
    height: fit(areaH, HEIGHT_RATIO, MIN_WINDOW_HEIGHT, MAX_DEFAULT_HEIGHT),
  };
}

function normalize(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function fit(area: number, ratio: number, min: number, max: number): number {
  const scaled = Math.round(area * ratio);
  const bounded = Math.min(max, Math.max(min, scaled));
  // 하한이 작업영역보다 큰 경우까지 포함해 화면 밖 크기를 만들지 않는다.
  return Math.min(bounded, Math.round(area));
}

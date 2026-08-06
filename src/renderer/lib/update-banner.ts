import type { UpdateState } from '../../shared/update-types';

/**
 * 메인 화면 업데이트 배너 판정 — 순수 함수.
 *
 * 도입 배경: 배너가 `status === 'downloaded'` 일 때만 떴다. 그런데 다운로드는 사용자 승인이
 * 있어야 시작되므로(autoDownload=false), **"새 버전이 나왔다"는 사실 자체를 설정 화면을 열어야만
 * 알 수 있었다.** 즉 자동 업데이트가 켜져 있어도 설정에 들어가지 않는 사용자는 영원히 구버전에
 * 머문다 — 확인·다운로드·설치 체인이 첫 칸에서 끊긴 셈이다.
 * 이제 available(승인 대기) → downloading(진행) → downloaded(설치 대기) 세 단계를 모두 배너로
 * 표면화한다. 다운로드는 여전히 사용자가 눌러야 시작되고(종량제 보호), 설치도 종전대로 승인이 필요하다.
 *
 * 표시 결정을 App.tsx 인라인이 아니라 여기 두는 이유: App 은 행위 테스트 하네스가 없어서
 * 인라인 조건은 회귀 넷을 붙일 수 없다(update-policy·window-flush-policy 와 같은 분리).
 */

export type UpdateBanner =
  /** 새 버전 확인됨 — 사용자의 다운로드 승인 대기 */
  | { kind: 'available'; version: string | null }
  /** 다운로드 진행 중 — 진행률만 알린다(조작 버튼 없음) */
  | { kind: 'downloading'; percent: number }
  /** 다운로드 완료 — 재시작 설치 대기 */
  | { kind: 'downloaded'; version: string | null };

/**
 * 표시할 배너. 그 외 상태(unsupported/idle/checking/not-available/error)는 배너를 띄우지 않는다.
 *
 * - checking: 사용자가 요청하지 않은 백그라운드 확인이라 매 기동 깜빡이면 소음이다.
 * - not-available: "최신입니다" 는 수동 확인의 응답이므로 설정 패널 소관.
 * - error: 자동 확인 실패로 메인 화면을 어지럽히지 않는다(설정 패널에 사유가 남는다).
 *
 * 버전 문자열이 비어 있어도(피드 이상) 배너 자체는 띄운다 — QA19(D-LOW) 와 동일 정책.
 * 표시 문구만 버전 미포함으로 폴백하도록 null 로 정규화한다.
 */
export function selectUpdateBanner(state: UpdateState | null | undefined): UpdateBanner | null {
  if (!state) return null;
  switch (state.status) {
    case 'available':
      return { kind: 'available', version: state.newVersion || null };
    case 'downloading':
      return { kind: 'downloading', percent: clampPercent(state.percent) };
    case 'downloaded':
      return { kind: 'downloaded', version: state.newVersion || null };
    default:
      return null;
  }
}

function clampPercent(percent: unknown): number {
  const n = Number(percent);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * 배너를 닫아둔 상태(dismiss)를 해제해야 하는가.
 *
 * 사용자가 "새 버전 있음"을 닫은 것은 **지금 다운로드하지 않겠다**는 뜻이지, 이후 단계까지
 * 보지 않겠다는 뜻이 아니다. 단계가 바뀌면(available→downloading→downloaded, 또는 새 버전이
 * 도착하면) 다시 보여준다. 같은 단계의 반복 브로드캐스트(다운로드 진행률 등)는 해제하지 않는다 —
 * 그러지 않으면 닫아도 즉시 되살아난다.
 */
export function shouldResetDismiss(prev: UpdateBanner | null, next: UpdateBanner | null): boolean {
  if (!next) return false;
  if (!prev) return true;
  if (prev.kind !== next.kind) return true;
  const prevVersion = 'version' in prev ? prev.version : null;
  const nextVersion = 'version' in next ? next.version : null;
  return prevVersion !== nextVersion;
}

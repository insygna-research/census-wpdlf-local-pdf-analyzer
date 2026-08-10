import type { SavedCollection } from '../../shared/collection-types';

/**
 * 컬렉션 영속화 IPC 래퍼 (multi-doc Phase 3 / module-1) — session-client 와 동일한 best-effort 패턴.
 * 모든 호출은 실패해도 throw 하지 않고 안전 기본값으로 수렴(목록은 빈 배열, 저장/삭제는 ok:false).
 */
/**
 * 컬렉션 목록. **`null` = 불러오지 못함**(일시 I/O 오류) — 빈 배열(정말 없음)과 구분한다.
 * QA23(D-LOW): 이전에는 둘을 모두 `[]` 로 수렴시켜, UI 가 EBUSY 한 번에 "저장된 컬렉션이
 * 없습니다" 를 단정적으로 보여줬다(사용자는 전량 소실로 읽는다 — 유일 사본이라 더더욱).
 */
export function listCollections(): Promise<SavedCollection[] | null> {
  return window.electronAPI.collections.list().catch(() => null);
}

export function saveCollection(
  input: { id?: string; name: string; docHashes: string[] },
): Promise<{ ok: boolean; id?: string; evicted?: string[] }> {
  return window.electronAPI.collections.save(input).catch(() => ({ ok: false }));
}

export function deleteCollection(id: string): Promise<{ ok: boolean }> {
  return window.electronAPI.collections.delete(id).catch(() => ({ ok: false }));
}

/**
 * 열기 시 최근 사용 표시. **fire-and-forget 으로 부르라** — 실패해도 열기 결과에 영향을 주지 않는다.
 * 없으면 목록 정렬·LRU 축출이 "최근 편집순" 이 된다(collections-store 의 touchCollection 주석).
 */
export function touchCollection(id: string): Promise<{ ok: boolean }> {
  return window.electronAPI.collections.touch(id).catch(() => ({ ok: false }));
}

import { describe, it, expect, vi, beforeEach } from 'vitest';

// R46 Important: handleAsk 의 컬렉션 배선을 추출한 resolveCollectionSearch 단위 테스트.
// 이전엔 컬렉션 오케스트레이션(멤버 해석→검색→verifier)이 단위 미테스트였다(E2E 만, CI skip).

const mockEmbed = vi.fn();
const mockSessionList = vi.fn();
const mockSessionLoad = vi.fn();
vi.stubGlobal('window', {
  electronAPI: {
    ai: { embed: mockEmbed, abort: vi.fn(() => Promise.resolve()) },
    session: { list: mockSessionList, load: mockSessionLoad },
  },
});
vi.stubGlobal('crypto', { randomUUID: () => 'test-uuid' });

import { resolveCollectionSearch } from '../use-qa';
import { useAppStore } from '../store';
import { VectorStore } from '../vector-store';

const MODEL = 'nomic-embed-text';

function seedActiveIndex(): void {
  const vs = new VectorStore();
  vs.setModel(MODEL);
  vs.addChunk('활성 문서 ALPHA 핵심', [1, 0, 0], 0, { pageStart: 2, pageEnd: 2 });
  useAppStore.getState().setRagIndex(vs);
}

function manifestEntry(docHash: string, model: string | null, dim: number | null) {
  return {
    docHash, fileName: `${docHash}.pdf`, filePath: `/d/${docHash}.pdf`, pageCount: 10,
    embedModel: model, embedDim: dim, chunkCount: model ? 5 : 0, byteSize: 100,
    createdAt: '2026-06-15T00:00:00Z', lastAccessed: '2026-06-15T00:00:00Z',
  };
}

function memberBlob(): { session: unknown; blob: ArrayBuffer } {
  const vs = new VectorStore();
  vs.setModel(MODEL);
  vs.addChunk('비활성 BETA 본문', [0.9, 0.1, 0], 0, { pageStart: 7, pageEnd: 7 });
  const s = vs.serialize();
  return {
    session: {
      schemaVersion: 1, docHash: 'b'.repeat(64), fileName: 'Beta.pdf', filePath: '/d/Beta.pdf',
      pageCount: 10, extractedText: 't', pageTexts: ['p'], chapters: [], summaries: {},
      summaryType: 'full', qaMessages: [], embedModel: s.model, embedDim: s.dimension, chunkMeta: s.chunkMeta,
    },
    blob: s.buffer,
  };
}

function setActive(memberHashes: string[], enabled = true): void {
  useAppStore.setState({
    document: {
      id: 'd', fileName: 'Alpha.pdf', filePath: '/d/Alpha.pdf', pageCount: 5,
      extractedText: 'x', pageTexts: [], chapters: [], images: [], createdAt: new Date(),
    },
    openTabs: [
      { filePath: '/d/Alpha.pdf', fileName: 'Alpha.pdf', pageCount: 5, docHash: 'a'.repeat(64) },
      { filePath: '/d/Beta.pdf', fileName: 'Beta.pdf', pageCount: 10, docHash: 'b'.repeat(64) },
    ],
    collection: { enabled, memberHashes },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEmbed.mockResolvedValue({ success: true, embeddings: [[1, 0, 0]], model: MODEL });
  mockSessionList.mockResolvedValue([manifestEntry('b'.repeat(64), MODEL, 3)]);
  mockSessionLoad.mockResolvedValue(memberBlob());
  useAppStore.getState().ragIndex.clear();
});

describe('resolveCollectionSearch', () => {
  it('컬렉션 비활성이면 즉시 null (session.list/embed 미호출), degraded=false', async () => {
    setActive(['a'.repeat(64), 'b'.repeat(64)], false);
    const out = await resolveCollectionSearch('질문');
    expect(out).toEqual({ ragResult: null, degraded: false });
    expect(mockSessionList).not.toHaveBeenCalled();
    expect(mockEmbed).not.toHaveBeenCalled();
  });

  it('활성+비활성 멤버 교차 검색 → 두 문서 출처 포함 + verifier + degraded=false', async () => {
    seedActiveIndex();
    setActive(['a'.repeat(64), 'b'.repeat(64)]);
    const out = await resolveCollectionSearch('질문');
    expect(out.ragResult).toContain('[Alpha.pdf p.2]');
    expect(out.ragResult).toContain('[Beta.pdf p.7]');
    expect(out.verifier?.size).toBeGreaterThan(0); // 멤버 인덱스 기반 검증기
    expect(out.degraded).toBe(false); // ready 2개 + 교차 결과 → 정상
  });

  it('검색 가능 멤버가 활성 1개뿐(나머지 모델 불일치)이면 degraded=true', async () => {
    seedActiveIndex();
    mockSessionList.mockResolvedValue([manifestEntry('b'.repeat(64), 'other-model', 1536)]); // Beta 제외
    setActive(['a'.repeat(64), 'b'.repeat(64)]);
    const out = await resolveCollectionSearch('질문');
    expect(out.ragResult).toContain('[Alpha.pdf p.2]'); // 활성으로 답변은 됨
    expect(out.degraded).toBe(true); // 단 검색 가능 문서가 1개뿐 → 강등 통지
  });

  it('#9: manifest 는 ready 지만 index.bin 로드 실패 멤버는 강등 판정에서 제외(과대계상 방지)', async () => {
    // Beta 는 manifest 상 모델 일치(ready)지만 session.load 가 실패(손상/IO) → 실제 인덱스 미로드.
    seedActiveIndex();
    mockSessionLoad.mockResolvedValue(null); // index.bin 로드 실패 시뮬레이션
    setActive(['a'.repeat(64), 'b'.repeat(64)]);
    const out = await resolveCollectionSearch('질문');
    expect(out.ragResult).toContain('[Alpha.pdf p.2]'); // 활성으로 답변은 됨
    // 구 코드(readyCount 기준)는 Beta 를 ready 로 세어 degraded=false 로 누락했음.
    // 실로드 store 1개(활성)뿐 → 교차 미발생 → degraded=true 가 정확.
    expect(out.degraded).toBe(true);
  });

  // QA21(D-MED, 조용한 오답): 기존 판정 `stores.length < 2` 는 **컬렉션이 붕괴한 경우만** 잡는다.
  // ready 3개 중 1개가 로드 실패해도 stores.length===2 라 degraded=false 였고, CollectionBar 는
  // manifest 기준으로 "3개 문서에서 검색" 을 계속 표시했다 — 사용자에게는 3개를 다 본 답변으로
  // 보인다. 기대치(ready 수)에 미달하면 강등으로 판정해야 한다.
  it('ready 3개 중 1개만 로드 실패해도 강등 — 붕괴가 아니어도 "다 봤다" 고 표시하면 안 된다', async () => {
    seedActiveIndex();
    const cHash = 'c'.repeat(64);
    const bHash = 'b'.repeat(64);
    mockSessionList.mockResolvedValue([
      manifestEntry(bHash, MODEL, 3),
      manifestEntry(cHash, MODEL, 3),
    ]);
    // Beta 는 정상 로드, Gamma 는 실패(손상 blob/세션 부재) → 실로드 store = 활성 + Beta = 2개
    mockSessionLoad.mockImplementation((h: string) => Promise.resolve(h === bHash ? memberBlob() : null));
    useAppStore.setState({
      document: {
        id: 'd', fileName: 'Alpha.pdf', filePath: '/d/Alpha.pdf', pageCount: 5,
        extractedText: 'x', pageTexts: [], chapters: [], images: [], createdAt: new Date(),
      },
      openTabs: [
        { filePath: '/d/Alpha.pdf', fileName: 'Alpha.pdf', pageCount: 5, docHash: 'a'.repeat(64) },
        { filePath: '/d/Beta.pdf', fileName: 'Beta.pdf', pageCount: 10, docHash: bHash },
        { filePath: '/d/Gamma.pdf', fileName: 'Gamma.pdf', pageCount: 10, docHash: cHash },
      ],
      collection: { enabled: true, memberHashes: ['a'.repeat(64), bHash, cHash] },
    });

    const out = await resolveCollectionSearch('질문');
    expect(out.ragResult).not.toBeNull();       // 답변은 된다(2개 문서 교차)
    expect(out.degraded, 'ready 3개 기대에 실로드 2개 → 강등 고지 필요').toBe(true);
  });

  it('교차 결과 없음(임베딩 실패)이면 ragResult null + degraded=true', async () => {
    seedActiveIndex();
    mockEmbed.mockResolvedValue({ success: false, error: 'fail' });
    setActive(['a'.repeat(64), 'b'.repeat(64)]);
    const out = await resolveCollectionSearch('질문');
    expect(out.ragResult).toBeNull();
    expect(out.degraded).toBe(true);
  });

  it('활성 문서가 memberHashes 에 없어도 강제 포함되어 검색됨', async () => {
    seedActiveIndex();
    setActive(['b'.repeat(64)]); // 사용자가 활성(Alpha) 체크 해제한 상태
    const out = await resolveCollectionSearch('질문');
    expect(out.ragResult).toContain('[Alpha.pdf p.2]'); // 활성 문서가 빠지지 않음
  });

  it('활성 인덱스 없음(model/dim null) → 모든 멤버 no-index → null 강등', async () => {
    // ragIndex 비움(model/dim null) → resolveMembers 가 전원 no-index
    setActive(['a'.repeat(64), 'b'.repeat(64)]);
    const out = await resolveCollectionSearch('질문');
    expect(out.ragResult).toBeNull();
  });

  it('활성 탭에 docHash 없으면 null', async () => {
    seedActiveIndex();
    useAppStore.setState({
      document: { id: 'd', fileName: 'X.pdf', filePath: '/d/X.pdf', pageCount: 1, extractedText: 'x', pageTexts: [], chapters: [], images: [], createdAt: new Date() },
      openTabs: [{ filePath: '/d/X.pdf', fileName: 'X.pdf', pageCount: 1 }], // docHash 없음
      collection: { enabled: true, memberHashes: [] },
    });
    const out = await resolveCollectionSearch('질문');
    expect(out).toEqual({ ragResult: null, degraded: false });
  });
});

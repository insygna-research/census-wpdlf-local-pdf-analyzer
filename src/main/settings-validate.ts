import { isValidOllamaUrl, MAX_TEMPLATE_ID_LEN } from '../shared/constants';

/**
 * 설정 값 검증 — **쓰기(settings:set)와 읽기(loadSettings)가 공유하는 단일 출처**.
 *
 * QA22(C-LOW): 이전에는 이 switch 가 `settings:set` 핸들러 안에만 있었다. 즉 IPC 로 들어오는
 * 값은 엄격히 검증하면서 **디스크에서 읽는 값은 키 화이트리스트만** 통과시켰다(settings-store 의
 * validKeys). 정상 경로로는 도달하지 않지만 settings.json 수기 편집/부분 손상이면:
 *  - `maxChunkSize: "abc"` → use-summarize 의 `Math.floor(NaN)` → 통합요약 예산 비교가 전부
 *    false 로 통과 → 청크 요약이 잘리지 않고 프롬프트에 투입(컨텍스트 초과로 조용한 품질 저하)
 *  - `customSummaryTemplates: "x"`(비배열) → SummaryTypeSelector 의 `.filter` 가 TypeError →
 *    **설정/선택기 화면 렌더 크래시**
 *  - `provider: "grok"` → 모든 generate 가 `Invalid provider` 로 실패
 * chunker.ts 의 sanitizeChunkSize 주석이 "수기 편집 손상" 을 명시적으로 위협 모델에 넣고 있는데
 * 방어가 그 한 곳에만 있던 비대칭이었다. 검증기를 모듈로 분리해 두 경로가 같은 규칙을 쓰고,
 * 규칙이 갈라지는 drift 도 함께 차단한다.
 *
 * 계약: 유효하면 `{ ok: true, value }`(정규화된 값), 아니면 `{ ok: false }` — 호출자는 후자를
 * 버리고 기본값을 쓴다.
 */

export const VALID_PROVIDERS = ['ollama', 'claude', 'openai', 'gemini'] as const;
export const VALID_THEMES = ['light', 'dark', 'system'] as const;
export const VALID_UI_LANGUAGES = ['ko', 'en'] as const;
export const VALID_SUMMARY_TYPES = ['full', 'chapter', 'keywords'] as const;
export const VALID_SUMMARY_LANGUAGES = ['ko', 'en', 'ja', 'zh', 'auto'] as const;

export type SettingsValidation = { ok: true; value: unknown } | { ok: false };

const okIf = (cond: boolean, value: unknown): SettingsValidation => (cond ? { ok: true, value } : { ok: false });

export function validateSettingValue(key: string, val: unknown): SettingsValidation {
  switch (key) {
    case 'provider':
      return okIf(VALID_PROVIDERS.includes(val as typeof VALID_PROVIDERS[number]), val);
    case 'model':
      return okIf(typeof val === 'string' && val.length > 0 && val.length <= 100, val);
    case 'ollamaBaseUrl':
      // 렌더러 UI 도 같은 함수로 저장 전에 차단한다(QA22 C-MED) — 규칙이 갈라지면
      // "UI 통과 → main 무음 드롭" 이 재현된다.
      return okIf(isValidOllamaUrl(val), val);
    case 'theme':
      return okIf(VALID_THEMES.includes(val as typeof VALID_THEMES[number]), val);
    case 'uiLanguage':
      return okIf(VALID_UI_LANGUAGES.includes(val as typeof VALID_UI_LANGUAGES[number]), val);
    case 'defaultSummaryType':
      return okIf(VALID_SUMMARY_TYPES.includes(val as typeof VALID_SUMMARY_TYPES[number]), val);
    case 'maxChunkSize':
      // QA9(C-LOW): Number.isInteger 로 float(예 1500.5) 저장 방지 — dim 검증과 대칭.
      return okIf(typeof val === 'number' && Number.isInteger(val) && val >= 1000 && val <= 16000, val);
    case 'enableImageAnalysis':
    case 'enableOcrFallback':
    case 'enableAnswerVerification':
    case 'persistSessions':
    case 'autoCheckUpdates':
      return okIf(typeof val === 'boolean', val);
    case 'summaryLanguage':
      return okIf(VALID_SUMMARY_LANGUAGES.includes(val as typeof VALID_SUMMARY_LANGUAGES[number]), val);
    case 'customSummaryTemplates': {
      // 커스텀 요약 템플릿 배열 — 각 항목 {id,name,prompt} 문자열 + 개수/길이 상한(renderer
      // MAX_CUSTOM_TEMPLATES/NAME/PROMPT 와 정합). 잘못된/빈 항목은 버리고 유효 항목만 남기며,
      // id/name/prompt 를 슬라이스해 과대 페이로드·프로토타입 오염을 방어한다.
      if (!Array.isArray(val)) return { ok: false };
      const clean = val
        .filter((it): it is { id: string; name: string; prompt: string; strategy?: unknown } => {
          if (!it || typeof it !== 'object') return false;
          const o = it as Record<string, unknown>;
          // id 상한은 shared 단일 출처 — 세션 요약 키(`custom:<id>`) 상한이 여기서 파생된다.
          return typeof o.id === 'string' && o.id.length > 0 && o.id.length <= MAX_TEMPLATE_ID_LEN
            && typeof o.name === 'string' && o.name.trim().length > 0
            && typeof o.prompt === 'string' && o.prompt.trim().length > 0;
        })
        .slice(0, 20)
        // strategy 는 'chunked' 만 유효, 그 외(미지정/오값)는 'single' 로 정규화(하위호환).
        .map((it) => ({
          id: it.id.slice(0, MAX_TEMPLATE_ID_LEN),
          name: it.name.slice(0, 60),
          prompt: it.prompt.slice(0, 4000),
          strategy: it.strategy === 'chunked' ? 'chunked' : 'single',
        }));
      return { ok: true, value: clean };
    }
    default:
      // 알 수 없는 키는 호출자(VALID_SETTINGS_KEYS 필터)가 이미 걸렀어야 한다.
      return { ok: false };
  }
}

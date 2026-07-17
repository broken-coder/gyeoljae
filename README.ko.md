# gyeoljae (결재)

**운영 원장과 메신저 사이의 human-in-the-loop 승인 브릿지.** — [English](README.md)

결재: 일이 진행되려면 결정권자의 도장이 필요한 그 의식. gyeoljae는 에이전트 운영에 정확히 그것을 제공합니다 — 에이전트는 원장(이슈 트래커)에 작업을 남기고, 사람은 메신저에서 승인하고, 기록되지 않은 승인으로는 아무것도 움직이지 않습니다.

> 상태: 초기 단계. 사설 운영 시스템에서 실제 가동 중인 Ruby 구현을 golden spec 삼아 TypeScript로 이식 중입니다.

> 릴리스 후보: `v0.2.0-rc.2`는 라이브러리와 `poll`/`listen`/`watch` CLI를 패키징합니다. [PR #13](https://github.com/broken-coder/gyeoljae/pull/13) 이후 public envelope에서는 source text와 `redacted_text`를 모두 제거합니다.

## 왜 필요한가

자율 에이전트를 실제 인프라에 붙여보면 두 가지를 배웁니다:

1. **모든 입력은 처리되기 전에 원장에 남아야 합니다.** 메시지를 읽다 죽은 에이전트는 메시지를 잃지만, 기록부터 하는 브릿지는 "기록됐지만 미처리"로 안전하게 물러납니다.
2. **승인은 채팅에서, 권위는 원장에서.** 사람은 Slack에 살지만, 진실의 원본이 채팅 스레드일 수는 없습니다.

## 동작 방식

```
메신저 ──인바운드──▶ sanitized envelope ──▶ 원장 (기록 먼저)
                                              │
                          분류: routine │ agent-required │ needs-human
                                              │
원장 이벤트 (승인 필요, 완료) ──아웃바운드──▶ 메신저 알림
사람의 "승인" 답글 ──검증──▶ 원장 기록 ──▶ 대기 중인 에이전트 재개
```

핵심 원칙 (코드로 강제됨):

- **envelope에는 내용이 없습니다.** `text_excerpt`는 shadow 모드에서 항상 null, 파일은 메타데이터(id/이름/타입/크기/해시)만. 내용 해석은 브릿지가 아니라 원장 뒤의 에이전트 몫입니다.
- **중복이 생기지 않습니다.** 모든 envelope에 멱등 `dedup_key`가 있어 재전송·재시도·수정에도 기록은 하나입니다.
- **알림 전달은 deduplicated at-least-once입니다.** 완료된 전송은 event key로 체크포인트하지만, 원격 전송 뒤 로컬 체크포인트 전에 프로세스가 종료되면 알림이 반복될 수 있습니다.
- **장애 복구는 replay입니다.** 원장이 죽어도 마지막 확인 시점 이후의 채팅 히스토리를 다시 읽으면 끝 — 관리할 큐가 없습니다.
- **판단하지 않습니다.** 분류는 한 화면에 읽히는 결정적 규칙이고, 애매하면 무조건 `needs-human`입니다.
- **credential은 agent에서 격리합니다.** 운영자가 관리하는 token file은 bridge 프로세스만 읽고 agent에는 전달하지 않습니다.

## 시작하기

```bash
npm install
npm test
npm run check:sanitize
npm run smoke:package
```

패키지는 ESM 전용입니다. `import`를 사용하며 CommonJS `require()`는 `v0.2.0-rc.2` 계약에 포함하지 않습니다.

사용 예시와 상세 설명은 [docs/getting-started.md](docs/getting-started.md)를 보세요.

## 기여

[CONTRIBUTING.md](CONTRIBUTING.md)를 먼저 읽어주세요. 핵심 규칙: 브릿지 코어에 LLM/내용 해석/agent-visible credential 처리를 넣는 PR은 받지 않습니다. 어댑터(`LedgerAdapter`, `ChatAdapter`)는 언제나 환영합니다.

## 라이선스

MIT

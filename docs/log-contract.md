# 공통 로그 계약

## 목적

로그 스키마는 저장 기술보다 오래 유지되어야 한다. 모든 프로젝트는 OpenTelemetry semantic convention을 우선하고, 대시보드 조회를 위한 세 개의 저카디널리티 분류값만 공통 인덱스 라벨로 사용한다.

## 필드 계약

| 의미 | OpenTelemetry resource | Loki index label | 필수 | 예 |
| --- | --- | --- | --- | --- |
| 프로젝트 | `service.namespace` | `project` | 예 | `mylinear` |
| 서비스 | `service.name` | `service` | 예 | `backend` |
| 환경 | `deployment.environment.name` | `environment` | 예 | `local` |
| 버전 | `service.version` | structured metadata | 권장 | `0.1.0` |
| 심각도 | `severityText`, `severityNumber` | 본문/metadata | 예 | `ERROR`, `17` |
| 이벤트 | `event.name` | structured metadata | 권장 | `auth.callback.failed` |
| trace | `traceId`, `spanId` | structured metadata | 가능할 때 | 16/32-byte ID |
| 상관관계 | `correlation.id` | structured metadata | 권장 | 요청 또는 사용자 흐름 ID |

`trace_id`, `user_id`, URL 전체값, 오류 메시지처럼 값 종류가 계속 늘어나는 필드는 Loki index label로 만들지 않는다. 인덱스 라벨 cardinality가 높아지면 저장·조회 비용이 급격히 증가한다.

## 메시지 원칙

- 한 줄은 한 사건을 설명한다.
- 메시지는 검색 가능한 안정적 동사와 결과를 포함한다.
- 동적 값은 attribute에 분리한다.
- 스택 트레이스는 오류 사건과 연결하되 같은 오류를 무한 반복하지 않는다.
- 운영 판단에 필요 없는 정상 반복 로그는 debug로 낮춘다.

예시:

```json
{
  "timestamp": "2026-08-26T13:10:00.000Z",
  "level": "ERROR",
  "message": "OAuth callback exchange failed",
  "event.name": "auth.callback.exchange_failed",
  "oauth.provider": "google",
  "error.type": "invalid_client",
  "correlation.id": "login-flow-7f22"
}
```

## 절대 기록하지 않는 값

- OAuth authorization code, access token, refresh token, ID token
- JWT 원문, 세션 쿠키, API key, client secret
- 비밀번호, 데이터베이스 연결 비밀번호
- 신용카드·주민번호 등 고위험 개인정보
- 필요 이상으로 상세한 이메일, 전화번호, 주소
- HTTP `Authorization`, `Cookie`, `Set-Cookie` header

Docker 경로에는 Alloy secret filter가 추가 방어선으로 존재하지만 애플리케이션 redaction을 대체하지 않는다. OTLP 로그는 애플리케이션에서 내보내기 전에 민감 필드를 제거하거나 hash 처리해야 한다.

## 오류 분류

사용자에게 보이는 메시지와 운영 분류를 분리한다.

```text
event.name=auth.callback.failed
error.type=oauth_token_exchange_rejected
error.retryable=false
http.response.status_code=401
```

이렇게 하면 메시지 문구가 바뀌어도 대시보드와 경보 규칙은 안정적으로 유지된다.

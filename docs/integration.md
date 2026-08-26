# 프로젝트 연결 가이드

## 연결 전 공통 결정

각 프로젝트는 다음 세 값만 먼저 정한다.

| 필드 | 예 | 규칙 |
| --- | --- | --- |
| `project` | `mylinear` | 제품 또는 저장소 단위, 안정적인 소문자 이름 |
| `service` | `backend`, `electron` | 실행 컴포넌트 단위 |
| `environment` | `local`, `dev`, `staging`, `prod` | 배포 환경 |

버전, trace ID, event 이름 같은 값은 함께 보내되 인덱스 라벨로 만들지 않는다. 상세 규칙은 [공통 로그 계약](log-contract.md)을 따른다.

## 방식 A: 같은 Docker 데몬의 Compose 프로젝트

플랫폼이 실행 중이면 별도 드라이버나 네트워크 연결 없이 자동 수집된다. 기본값은 Compose project와 service, 환경은 `local`이다.

명시적 이름이 필요할 때만 각 서비스에 라벨을 추가한다.

```yaml
services:
  backend:
    labels:
      observability.project: mylinear
      observability.service: backend
      observability.environment: local
```

적용 후 프로젝트를 다시 시작하고 다음 API로 라벨을 확인한다.

```bash
curl -G http://127.0.0.1:3100/loki/api/v1/series \
  --data-urlencode 'match[]={project="mylinear"}'
```

### mylinear의 현재 연결

`mylinear`의 Spring API와 PostgreSQL은 같은 Docker 데몬에서 실행되므로 플랫폼이 Compose 메타데이터를 자동으로 읽는다. Grafana에서 Project `mylinear`, Service `backend`를 선택하면 Spring console log를 볼 수 있다. DB 로그가 불필요하면 이후 수집 opt-out 규칙을 추가하는 것이 다음 단계다.

## 방식 B: Electron·Node·호스트 앱의 OTLP

로컬 앱은 다음 endpoint를 사용한다.

- HTTP/protobuf 또는 HTTP/JSON: `http://127.0.0.1:4318`
- gRPC: `http://127.0.0.1:4317`

OpenTelemetry SDK의 resource attributes는 다음처럼 맞춘다.

```text
service.namespace=mylinear
service.name=electron
service.version=0.1.0
deployment.environment.name=local
```

Alloy가 semantic attribute를 대시보드 공통 라벨로 정규화한다. SDK 설정을 붙이기 전 파이프라인만 확인하려면 다음 명령을 사용한다.

```bash
npm run emit -- mylinear electron local INFO "INFO Electron logger connected"
```

로그인·OAuth 흐름에서는 authorization code, access/refresh/ID token, 쿠키, 이메일 전체값을 로그 본문에 넣지 않는다. 성공/실패, provider, 단계, 오류 분류, correlation ID만 기록한다.

## 방식 C: 다른 호스트 또는 원격 환경

현재 OTLP 포트는 보안을 위해 `127.0.0.1`에만 열려 있다. 포트 바인딩을 `0.0.0.0`으로 바꿔 직접 노출하지 않는다.

권장 순서는 다음과 같다.

1. 애플리케이션 호스트마다 Alloy를 sidecar 또는 agent로 실행한다.
2. 중앙 Loki 앞에 TLS와 인증 gateway를 둔다.
3. 각 Alloy가 인증된 endpoint로 전송한다.
4. tenant 또는 environment 별 접근 정책을 적용한다.

개발 중 임시 확인은 SSH tunnel을 사용할 수 있지만, 팀 공용 운영 설계로 간주하지 않는다.

## 연결 검증

1. 애플리케이션에서 고유한 안전한 테스트 메시지를 1건 발생시킨다.
2. Loki label API에서 `project`, `service`, `environment`가 보이는지 확인한다.
3. Grafana 대시보드에서 같은 필터를 선택한다.
4. 최신 로그에서 timestamp, severity, event, trace/correlation ID를 확인한다.
5. 고의로 넣은 가짜 토큰 문자열이 Docker 경로에서 마스킹되는지 비운영 데이터로 확인한다.

플랫폼 자체의 end-to-end 검증은 `npm run smoke`로 실행한다.

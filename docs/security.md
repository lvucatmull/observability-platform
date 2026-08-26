# 보안과 운영 경계

## 현재 기본값

- Grafana 익명 접근과 사용자 가입 비활성화
- 무작위 admin 비밀번호를 로컬 `.env`에 생성하고 mode `0600` 적용
- Grafana, Loki, Alloy UI, OTLP를 모두 `127.0.0.1`에만 바인딩
- 저장소 추적 파일에서 대표 secret 패턴과 `.env` 추적 여부 검사
- Docker console log에 Alloy secret filter 적용, timeout 시 해당 line 폐기
- 이미지 버전 고정
- Grafana analytics, update check, news feed 비활성화

## 중요한 경계

### Loki에는 내장 인증이 없다

현재 Loki API가 안전한 이유는 인터넷에 노출되지 않고 loopback에서만 접근되기 때문이다. `0.0.0.0:3100`으로 변경해 직접 공개하면 안 된다. 원격 환경에서는 인증·TLS gateway를 앞에 둔다.

### Docker socket은 강한 권한이다

socket은 read-only mount지만 Docker API 자체 권한을 파일 권한만으로 완전히 제한하지 못한다. 신뢰할 수 없는 Alloy 설정이나 이미지를 실행하지 않는다. 중앙 운영에서는 socket proxy, rootless runtime, Kubernetes API 같은 더 좁은 수집 방식을 선택한다.

### 필터는 애플리케이션 책임을 없애지 않는다

Docker secret filter는 알려진 형태를 탐지하는 추가 방어선이다. 모든 비밀 형식을 보장하지 않으며 CPU 비용도 있다. OTLP 경로는 native protocol을 유지하기 위해 이 필터를 거치지 않으므로 SDK exporter 전 단계에서 민감 값을 제거해야 한다.

Alloy 1.18에서 `loki.secretfilter`는 experimental component다. 따라서 이미지 버전을 고정하고 CI에서 같은 stability level로 시작·수집을 검증한다. component 변경이 생기면 자동 업그레이드하지 않고 release note와 redaction 회귀 테스트를 먼저 확인한다.

## 원격 운영 체크리스트

- [ ] Grafana OIDC와 역할별 조직/폴더 권한
- [ ] Loki·OTLP gateway의 TLS와 인증
- [ ] tenant 분리 또는 프로젝트별 접근 정책
- [ ] 오브젝트 스토리지 암호화와 보존·삭제 정책
- [ ] 백업 복구 시험
- [ ] 수집기·저장소 자체 metrics와 alert
- [ ] 이미지 서명·취약점 검사·정기 업데이트
- [ ] 로그 내 개인정보 최소화와 삭제 요청 절차

## 사고 시 비밀 노출 대응

1. 로그 유입을 중단하거나 문제가 된 exporter를 차단한다.
2. 노출된 credential을 먼저 폐기·재발급한다.
3. 영향 시간과 stream label을 좁힌다.
4. 보존 데이터 삭제는 백업·규정 영향을 확인한 뒤 수행한다.
5. redaction 규칙과 발생 애플리케이션 테스트를 함께 추가한다.

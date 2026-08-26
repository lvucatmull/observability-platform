import { startSessionReplay } from "/assets/replay-recorder.js";

const replay = startSessionReplay({
  endpoint: window.location.origin,
  project: "replay-demo",
  service: "browser",
  environment: "local",
  enabled: true,
  consent: true,
  samplingRate: 1,
  onError(error) {
    document.querySelector("#session-status").textContent = error.message;
  },
});

document.querySelector("#session-status").textContent = `Recording ${replay.sessionId}`;
document.querySelector("#add-issue").addEventListener("click", () => {
  const item = document.createElement("li");
  item.innerHTML = `<span>MYL-${43 + document.querySelectorAll("#issues li").length}</span> Recorded interaction`;
  document.querySelector("#issues").prepend(item);
});

window.addEventListener("pagehide", () => void replay.stop(), { once: true });

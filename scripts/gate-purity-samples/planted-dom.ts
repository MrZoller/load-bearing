// Sample: browser globals. Violates invariant 3 on purpose.
export function paint(): void {
  const host = document.querySelector("#terminal");
  if (host && window.innerWidth > 0) {
    localStorage.setItem("seed", "1");
  }
}

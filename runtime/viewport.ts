/** Keep browser chrome/software keyboards from obscuring the active prompt. */
export function observeVisualViewport(document: Document): void {
  const defaultView = document.defaultView;
  if (defaultView === null) return;
  const browser: Window = defaultView;
  const viewport = browser.visualViewport;

  function update(): void {
    const height = viewport?.height ?? browser.innerHeight;
    document.documentElement.style.setProperty(
      "--visual-viewport-height",
      `${String(Math.round(height))}px`,
    );
    browser.requestAnimationFrame(() => {
      const focused = document.activeElement;
      if (focused?.matches("input") === true)
        focused.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
  }

  viewport?.addEventListener("resize", update);
  viewport?.addEventListener("scroll", update);
  browser.addEventListener("resize", update);
  update();
}

// Sample: network access. Violates invariant 6 on purpose.
export async function ask(prompt: string): Promise<string> {
  const response = await fetch("https://example.test/v1", { body: prompt });
  return response.text();
}

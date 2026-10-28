import { expect, test, type Page } from "@playwright/test";

/**
 * The page, in a real browser: what unit tests cannot see because it happens
 * between React, the address bar and the server (decisions 48 and 50).
 */

// Questions the fixture regulations answer, with the hashing embeddings of
// the fake model: Decreto 834/2026 and Ley 27817.
const LIBRARIANS = "Retribución de los cargos de la Escuela Nacional de Bibliotecarios";
const SAN_MARINO = "Convenio de seguridad social con la República de San Marino";

/** An answer that ended: the line that says who wrote it. */
const ANSWERED_ES = /Respuesta de ollama · fake/;
const ANSWERED_EN = /Answer by ollama · fake/;

/** Every question the page sends to the server, as its address. */
function answerRequests(page: Page): URL[] {
  const sent: URL[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/answer") sent.push(url);
  });
  return sent;
}

/** Opens the filters, which stay folded while none is set. */
async function openFilters(page: Page) {
  await page.locator("summary", { hasText: "Filtros" }).click();
}

async function ask(page: Page, question: string) {
  await page.getByLabel("Pregunta", { exact: true }).fill(question);
  await page.getByRole("button", { name: "Preguntar" }).click();
}

test("the sources come before the answer, and each citation leads to its source", async ({
  page,
}) => {
  await page.goto("/es");
  await ask(page, LIBRARIANS);

  const sources = page.getByRole("region", { name: "Fuentes" });
  await expect(sources).toBeVisible();
  // The sources are on the page while the answer is still being written.
  await expect(page.getByText(ANSWERED_ES)).toBeHidden();

  await expect(page.getByText(ANSWERED_ES)).toBeVisible();
  const answer = page.getByRole("region", { name: "Respuesta" });
  await expect(answer).toContainText("La primera fuente es Decreto 834");

  await answer.getByRole("link", { name: "1", exact: true }).first().click();
  await expect(page).toHaveURL(/#source-1$/);
  await expect(page.locator("#source-1")).toContainText("Decreto 834/2026");
});

test("stopping stops the answer and does not send the question again", async ({
  page,
}) => {
  const sent = answerRequests(page);
  await page.goto("/es");
  await ask(page, LIBRARIANS);

  await page.getByRole("button", { name: "Detener" }).click();
  await expect(page.getByText("Se detuvo la respuesta.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Preguntar" })).toBeVisible();

  // The stop button turned back into "Ask" under the click and sent the
  // question again: decision 48.
  await page.waitForTimeout(1_000);
  expect(sent).toHaveLength(1);
  await expect(page.getByText(ANSWERED_ES)).toBeHidden();
});

test("the filters go to the server and into the address", async ({ page }) => {
  const sent = answerRequests(page);
  await page.goto("/es");
  await openFilters(page);
  await page.getByLabel("Tipo de norma").selectOption("Decreto");
  await page.getByLabel("Desde el año").fill("2026");
  await ask(page, LIBRARIANS);

  await expect(page.getByText(ANSWERED_ES)).toBeVisible();
  const address = new URL(page.url()).searchParams;
  expect(address.get("q")).toBe(LIBRARIANS);
  expect(address.get("type")).toBe("Decreto");
  expect(address.get("from")).toBe("2026");
  expect(sent[0]?.searchParams.get("type")).toBe("Decreto");
  expect(sent[0]?.searchParams.get("from")).toBe("2026");
  expect(sent[0]?.searchParams.get("lang")).toBe("es");
});

test("a link opens the page with its question, its filters and its answer", async ({
  page,
}) => {
  await page.goto(`/es?q=${encodeURIComponent(LIBRARIANS)}&type=Decreto&from=2026`);

  await expect(page.getByText(ANSWERED_ES)).toBeVisible();
  await expect(page.getByLabel("Pregunta", { exact: true })).toHaveValue(LIBRARIANS);
  // A filter in the address opens the filters, so it is not hidden.
  await expect(page.getByLabel("Tipo de norma")).toHaveValue("Decreto");
  await expect(page.getByLabel("Desde el año")).toHaveValue("2026");
});

test("a link with a wrong filter opens without that filter", async ({ page }) => {
  await page.goto(
    `/es?q=${encodeURIComponent(LIBRARIANS)}&type=${encodeURIComponent("Resolución")}&from=1500`,
  );

  await expect(page.getByText(ANSWERED_ES)).toBeVisible();
  await openFilters(page);
  await expect(page.getByLabel("Tipo de norma")).toHaveValue("");
  await expect(page.getByLabel("Desde el año")).toHaveValue("");
});

test("going back shows the answer before, without asking again", async ({ page }) => {
  const sent = answerRequests(page);
  await page.goto("/es");
  await ask(page, LIBRARIANS);
  await expect(page.getByText(ANSWERED_ES)).toBeVisible();
  await ask(page, SAN_MARINO);
  await expect(page.getByText(ANSWERED_ES)).toBeVisible();

  await page.goBack();
  await expect(page.getByLabel("Pregunta", { exact: true })).toHaveValue(LIBRARIANS);
  await expect(page.getByRole("region", { name: "Respuesta" })).toContainText(
    "Decreto 834",
  );
  expect(sent).toHaveLength(2);

  await page.goBack();
  await expect(page).toHaveURL(/\/es$/);
  await expect(page.getByLabel("Pregunta", { exact: true })).toHaveValue("");
  await expect(page.getByRole("region", { name: "Respuesta" })).toBeHidden();
});

test("changing the language keeps what was being written", async ({ page }) => {
  await page.goto("/es");
  await page.getByLabel("Pregunta", { exact: true }).fill("una pregunta sin enviar");
  await openFilters(page);
  await page.getByLabel("Tipo de norma").selectOption("Ley");
  await page.getByLabel("Hasta el año").fill("2020");

  await page.getByRole("link", { name: "English" }).click();
  await expect(page).toHaveURL(/\/en$/);
  await expect(page.getByLabel("Question", { exact: true })).toHaveValue(
    "una pregunta sin enviar",
  );
  await expect(page.getByLabel("Type of regulation")).toHaveValue("Ley");
  await expect(page.getByLabel("To the year")).toHaveValue("2020");
});

test("changing the language keeps the answer, and it can be asked for in the new one", async ({
  page,
}) => {
  const sent = answerRequests(page);
  await page.goto("/es");
  await ask(page, LIBRARIANS);
  await expect(page.getByText(ANSWERED_ES)).toBeVisible();

  await page.getByRole("link", { name: "English" }).click();
  await expect(page).toHaveURL(/\/en\?q=/);
  // The page speaks English; the answer stays as it was written.
  await expect(page.getByText(ANSWERED_EN)).toBeVisible();
  await expect(page.getByRole("region", { name: "Answer" })).toContainText(
    "La primera fuente es",
  );
  expect(sent).toHaveLength(1);

  await page.getByRole("button", { name: "Answer in English" }).click();
  await expect(page.getByRole("region", { name: "Answer" })).toContainText(
    "The first source is",
  );
  expect(sent).toHaveLength(2);
  expect(sent[1]?.searchParams.get("lang")).toBe("en");
  await expect(page.getByRole("button", { name: "Answer in English" })).toBeHidden();
});

test("reloading shows the answer already given", async ({ page }) => {
  const sent = answerRequests(page);
  await page.goto("/es");
  await ask(page, LIBRARIANS);
  await expect(page.getByText(ANSWERED_ES)).toBeVisible();

  await page.reload();
  await expect(page.getByText(ANSWERED_ES)).toBeVisible();
  expect(sent).toHaveLength(1);
});

test("a question too short is not sent", async ({ page }) => {
  const sent = answerRequests(page);
  await page.goto("/es");
  await ask(page, "ab");

  await expect(page.getByText("Escriba al menos 3 caracteres.")).toBeVisible();
  expect(sent).toHaveLength(0);
});

test.describe("without JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test("the form takes the question to the address and says why there is no answer", async ({
    page,
  }) => {
    await page.goto("/es");
    await page.getByLabel("Pregunta", { exact: true }).fill(LIBRARIANS);
    await page.getByRole("button", { name: "Preguntar" }).click();

    await expect(page).toHaveURL(/\/es\?q=Retribuci/);
    await expect(page.getByLabel("Pregunta", { exact: true })).toHaveValue(LIBRARIANS);
    await expect(page.getByText(/necesita JavaScript/)).toBeVisible();
  });
});

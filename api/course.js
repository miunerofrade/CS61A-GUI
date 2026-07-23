const ALLOWED_HOST = "cs61a.org";
const MAX_BYTES = 50 * 1024 * 1024;

export default async function handler(request, response) {
  if (request.method !== "GET") {
    response.status(405).json({ error: "Method not allowed" });
    return;
  }

  let target;
  try {
    target = new URL(String(request.query.url || ""));
  } catch {
    response.status(400).json({ error: "Invalid URL" });
    return;
  }
  if (target.protocol !== "https:" || target.hostname !== ALLOWED_HOST) {
    response.status(403).json({ error: "Only cs61a.org resources are allowed" });
    return;
  }

  try {
    const upstream = await fetch(target, {
      redirect: "follow",
      headers: { "User-Agent": "CS61A-GUI/1.0" },
    });
    if (new URL(upstream.url).hostname !== ALLOWED_HOST) {
      response.status(403).json({ error: "Redirect target is not allowed" });
      return;
    }
    if (!upstream.ok) {
      response.status(upstream.status).json({ error: "Official resource unavailable" });
      return;
    }
    const declared = Number(upstream.headers.get("content-length") || "0");
    if (declared > MAX_BYTES) {
      response.status(413).json({ error: "Resource is too large" });
      return;
    }
    const body = Buffer.from(await upstream.arrayBuffer());
    if (body.byteLength > MAX_BYTES) {
      response.status(413).json({ error: "Resource is too large" });
      return;
    }
    response.setHeader(
      "Content-Type",
      upstream.headers.get("content-type") || "application/octet-stream",
    );
    response.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
    response.status(200).send(body);
  } catch {
    response.status(502).json({ error: "Unable to reach cs61a.org" });
  }
}

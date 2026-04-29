import type { IncomingMessage, ServerResponse } from "node:http";

interface AdminAuthRequest {
	url?: string;
	headers: IncomingMessage["headers"];
}

export function getConfiguredAdminToken(env: NodeJS.ProcessEnv = process.env): string | null {
	const token = env.PI_ROTATOR_ADMIN_TOKEN?.trim();
	return token ? token : null;
}

export function getRequestAdminToken(req: AdminAuthRequest): string | null {
	const headerToken = req.headers["x-rotator-admin-token"];
	if (typeof headerToken === "string" && headerToken) return headerToken;
	if (Array.isArray(headerToken) && headerToken[0]) return headerToken[0];

	const authorization = req.headers.authorization;
	if (typeof authorization === "string" && authorization.toLowerCase().startsWith("bearer ")) {
		return authorization.slice("bearer ".length).trim();
	}

	try {
		const requestUrl = new URL(req.url || "/", "http://localhost");
		return requestUrl.searchParams.get("token");
	} catch {
		return null;
	}
}

export function isAdminAuthorized(
	req: AdminAuthRequest,
	expectedToken: string | null = getConfiguredAdminToken(),
): boolean {
	if (!expectedToken) return true;
	return getRequestAdminToken(req) === expectedToken;
}

export function requireAdmin(req: IncomingMessage, res: ServerResponse): boolean {
	if (isAdminAuthorized(req)) return true;
	res.writeHead(401, {
		"Content-Type": "application/json",
		"Cache-Control": "no-store",
		"WWW-Authenticate": "Bearer",
	});
	res.end(JSON.stringify({ error: "Unauthorized" }));
	return false;
}

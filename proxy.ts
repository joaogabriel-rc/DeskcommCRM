import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookieSecure } from "@/lib/supabase/cookie-secure";
import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/lib/env";
import { isPublicPath } from "@/lib/auth/public-paths";
import {
  verifyImpersonateCookieEdge,
  IMPERSONATE_COOKIE_NAME_EDGE,
} from "@/lib/impersonate/cookie-edge";
import { assinarIdentidade, CABECALHO_IDENTIDADE } from "@/lib/auth/identidade-assinada";

const COOKIE_NAME = "sb-deskcomm-auth";

export async function proxy(request: NextRequest) {
  // A identidade verificada só pode nascer AQUI. Apagada antes de qualquer ramo
  // (inclusive o público): o que o navegador mandar com esse nome não chega ao
  // handler. Ver `lib/auth/identidade-assinada.ts`.
  request.headers.delete(CABECALHO_IDENTIDADE);
  let response = NextResponse.next({ request: { headers: request.headers } });

  // Inject X-Request-Id for downstream correlation (audit log, error wrappers).
  const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
  response.headers.set("x-request-id", requestId);

  const { pathname, search } = request.nextUrl;
  // Expose pathname to Server Components via header (used by onboarding layout).
  response.headers.set("x-pathname", pathname);
  request.headers.set("x-pathname", pathname);

  // EPIC-11: the admin surface is reached by PATH (`/admin/*`) — the self-host kit
  // points `NEXT_PUBLIC_ADMIN_URL` at the same host as the app and maps no `admin.`
  // sub-domain. The host-based branch below stays a NOOP today and only exists as
  // documentation of the intended deploy topology.
  const host = request.headers.get("host") ?? "";
  const isAdminSurface = host.startsWith("admin.") || pathname.startsWith("/admin");

  if (isPublicPath(pathname)) {
    return response;
  }

  const cookiesRenovados: { name: string; value: string; options: CookieOptions }[] = [];
  const supabase = createServerClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
          cookiesToSet.forEach(({ name, value, options }) => {
            request.cookies.set(name, value);
            response.cookies.set(name, value, options);
            cookiesRenovados.push({ name, value, options });
          });
        },
      },
      cookieOptions: {
        name: COOKIE_NAME,
        sameSite: "strict",
        httpOnly: true,
        secure: cookieSecure(),
        path: "/",
      },
    },
  );

  // Validate JWT server-side (NEVER use getSession on backend per CLAUDE.md).
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    // API routes must respond with JSON envelope (contract: {error:{code,message}})
    // — never redirect HTML to JSON consumers. UI routes redirect to /login as before.
    if (pathname.startsWith("/api/")) {
      return new NextResponse(
        JSON.stringify({
          error: {
            code: "unauthenticated",
            message: "Authentication required",
          },
        }),
        {
          status: 401,
          headers: {
            "content-type": "application/json",
            "x-request-id": requestId,
          },
        },
      );
    }
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", pathname + search);
    return NextResponse.redirect(loginUrl);
  }

  // Entrega ao handler o usuário que ESTE `getUser()` acabou de validar, para
  // que `loadAuthUser`/`isMfaEnrolled`/rotas não repitam a mesma ida ao GoTrue
  // (medido: 3 `GET /auth/v1/user` por requisição de API, ~250 ms cada).
  //
  // A resposta é RECONSTRUÍDA porque `NextResponse.next({ request })` copia os
  // cabeçalhos no momento em que é criada: o `response` do topo foi montado
  // antes do `getUser()` e não leva nem este cabeçalho nem os cookies que o
  // refresh da sessão acabou de gravar em `request.cookies`. Com isso o handler
  // passa a enxergar a MESMA sessão que o navegador vai receber — a amarra da
  // assinatura é feita sobre ela.
  const assinatura = await assinarIdentidade(
    user,
    { nome: COOKIE_NAME, todos: request.cookies.getAll() },
    env.SUPABASE_SERVICE_ROLE_KEY,
  );
  if (assinatura) {
    request.headers.set(CABECALHO_IDENTIDADE, assinatura);
    const encaminhada = NextResponse.next({ request: { headers: request.headers } });
    encaminhada.headers.set("x-request-id", requestId);
    encaminhada.headers.set("x-pathname", pathname);
    for (const { name, value, options } of cookiesRenovados) {
      encaminhada.cookies.set(name, value, options);
    }
    response = encaminhada;
  }

  // EPIC-11 S-11.07: validate impersonate cookie on /app/* paths. Middleware
  // runs in Edge — no DB access, only HMAC + expiry. On any failure we delete
  // the presentation cookie. The database support session remains authoritative:
  // expired/revoked support still blocks the app until explicit exit.
  if (pathname.startsWith("/app")) {
    const impCookie = request.cookies.get(IMPERSONATE_COOKIE_NAME_EDGE)?.value;
    if (impCookie) {
      const result = await verifyImpersonateCookieEdge(
        impCookie,
        env.IMPERSONATE_COOKIE_SECRET ?? "",
      );
      if (!result.valid) {
        console.warn(
          `[middleware] impersonate cookie invalid (${result.reason ?? "unknown"}) — clearing`,
        );
        response.cookies.delete(IMPERSONATE_COOKIE_NAME_EDGE);
      }
    }
  }

  // /admin/* additionally requires platform_admin (early gate — authoritative
  // check is server-side in `requirePlatformAdmin`). Skip the RPC for
  // `/admin/forbidden` (rendered to non-admins, would otherwise loop).
  if (isAdminSurface && pathname.startsWith("/admin") && pathname !== "/admin/forbidden") {
    const { data: isAdmin, error } = await supabase.rpc("fn_is_platform_admin");
    if (error || !isAdmin) {
      return NextResponse.redirect(new URL("/admin/forbidden", request.url));
    }
  }

  return response;
}

export const config = {
  matcher: [
    // Run on all paths except static assets / Next internals.
    "/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js)$).*)",
  ],
};

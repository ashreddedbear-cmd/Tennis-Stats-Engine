import express, { type Express, type ErrorRequestHandler } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import { clerkMiddleware } from "@clerk/express";
import { publishableKeyFromHost } from "@clerk/shared/keys";
import { CLERK_PROXY_PATH, clerkProxyMiddleware, getClerkProxyHost } from "./middlewares/clerkProxyMiddleware";
import router from "./routes";
import { logger } from "./lib/logger";
import { formatDatabaseError } from "./lib/databaseError";
import { generalApiLimiter } from "./middlewares/rateLimiter";

const app: Express = express();

// Clerk proxy must be mounted before body parsers (streams raw bytes)
app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
// Default express.json() limit (100kb) is too small for a base64-encoded screenshot upload
// (POST /matchups/from-screenshot) -- raised globally rather than per-route since Express body
// parsing happens before routing.
app.use(express.json({
  limit: "10mb",
  verify: (req, _res, buffer) => {
    (req as express.Request & { rawBody?: Buffer }).rawBody = Buffer.from(buffer);
  },
}));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
// Task #143: signs the admin-session cookie set by POST /api/auth/login so `req.signedCookies`
// is available to `requireAdmin`. Reuses SESSION_SECRET rather than introducing a second secret.
app.use(cookieParser(process.env.SESSION_SECRET));

// Clerk session middleware — resolves auth from session cookie.
// getClerkProxyHost ensures dev and prod use the same canonical host.
app.use(
  clerkMiddleware((req) => ({
    publishableKey: publishableKeyFromHost(
      getClerkProxyHost(req) ?? "",
      process.env.CLERK_PUBLISHABLE_KEY,
    ),
  })),
);

// Without this, a malformed body or an over-limit upload (e.g. too-large screenshot on
// POST /matchups/from-screenshot) falls through to Express's default handler, which returns an
// HTML page with a raw stack trace instead of the clean JSON error shape every route in this API
// uses -- and it leaks internal file paths in the process.
const bodyParserErrorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  if (err && typeof err === "object" && "type" in err && "status" in err) {
    const status = typeof err.status === "number" ? err.status : 400;
    res.status(status).json({ error: "Invalid request body", detail: (err as Error).message });
    return;
  }
  next(err);
};
app.use(bodyParserErrorHandler);

// Broad per-IP rate limiter applied to every /api route before routing.
// Specific tighter limiters (auth, predictions) are mounted at the route level.
app.use("/api", generalApiLimiter);

app.use("/api", router);

const apiErrorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  const dbErr = formatDatabaseError(err, "Unhandled server error");
  logger.error({ err, dbError: dbErr.log }, "Unhandled API error");
  res.status(dbErr.status).json(dbErr.body);
};

app.use(apiErrorHandler);

export default app;

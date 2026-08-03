import { Router, type IRouter } from "express";
import healthRouter from "./health";
import providerRouter from "./provider";
import playersRouter from "./players";
import fixturesRouter from "./fixtures";
import h2hRouter from "./h2h";
import matchupsRouter from "./matchups";
import predictionsRouter from "./predictions";
import evaluationRouter from "./evaluation";
import authRouter from "./auth";
import backtestsRouter from "./backtests";
import launchAuditRouter from "./launchAudit";
import liveAuditsRouter from "./liveAudits";
import paymentsRouter from "./payments";

const router: IRouter = Router();

router.use(authRouter);
router.use(healthRouter);
router.use(providerRouter);
router.use(playersRouter);
router.use(fixturesRouter);
router.use(h2hRouter);
router.use(matchupsRouter);
router.use(predictionsRouter);
router.use(evaluationRouter);
router.use(backtestsRouter);
router.use(launchAuditRouter);
router.use(liveAuditsRouter);
router.use(paymentsRouter);

export default router;

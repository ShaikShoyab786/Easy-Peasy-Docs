import { Router, type IRouter } from "express";
import healthRouter from "./health";
import simplifyRouter from "./simplify";

const router: IRouter = Router();

router.use(healthRouter);
router.use(simplifyRouter);

export default router;

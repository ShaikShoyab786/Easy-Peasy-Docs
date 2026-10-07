import { Router, type IRouter } from "express";
import healthRouter from "./health";
import simplifyRouter from "./simplify";
import documentExtractionRouter from "./document-extraction";

const router: IRouter = Router();

router.use(healthRouter);
router.use(simplifyRouter);
router.use(documentExtractionRouter);

export default router;

import { Router, type IRouter } from "express";
import healthRouter from "./health";
import simplifyRouter from "./simplify";
import documentExtractionRouter from "./document-extraction";
import accountRouter from "./account";
import conversationsRouter from "./conversations";
import documentsRouter from "./documents";

const router: IRouter = Router();

router.use(healthRouter);
router.use(accountRouter);
router.use(conversationsRouter);
router.use(documentsRouter);
router.use(simplifyRouter);
router.use(documentExtractionRouter);

export default router;

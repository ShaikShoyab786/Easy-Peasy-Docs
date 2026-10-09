import { Router, type IRouter } from "express";
import healthRouter from "./health";
import accountRouter from "./account";
import conversationsRouter from "./conversations";
import guestChatRouter from "./guest-chat";
import knowledgeDocumentsRouter from "./knowledge-documents";

const router: IRouter = Router();

router.use(healthRouter);
router.use(accountRouter);
router.use(conversationsRouter);
router.use(guestChatRouter);
router.use(knowledgeDocumentsRouter);

export default router;

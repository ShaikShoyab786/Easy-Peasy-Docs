import { Router, type IRouter } from "express";
import healthRouter from "./health";
import accountRouter from "./account";
import conversationsRouter from "./conversations";
import guestChatRouter from "./guest-chat";

const router: IRouter = Router();

router.use(healthRouter);
router.use(accountRouter);
router.use(conversationsRouter);
router.use(guestChatRouter);

export default router;

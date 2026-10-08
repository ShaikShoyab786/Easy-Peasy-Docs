import { Router, type IRouter } from "express";
import {
  getAuthenticatedUserId,
  requireAuth,
} from "../middlewares/require-auth";

const router: IRouter = Router();

router.get("/account", requireAuth, (req, res) => {
  res.json({ userId: getAuthenticatedUserId(req) });
});

export default router;

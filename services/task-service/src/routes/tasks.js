import { Router } from "express";
import { handleGetTasks, handleCreateTask, handleDeleteTasks } from "../controllers/taskController.js";

const router = Router();

router.get("/", handleGetTasks);
router.post("/", handleCreateTask);
router.delete("/", handleDeleteTasks);

export default router;

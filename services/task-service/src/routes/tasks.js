import { Router } from "express";
import { handleGetTasks, handleCreateTask, handleDeleteTasks, handleCompleteTasks } from "../controllers/taskController.js";

const router = Router();

router.get("/", handleGetTasks);
router.post("/", handleCreateTask);
router.delete("/", handleDeleteTasks);
router.patch("/complete", handleCompleteTasks);

export default router;

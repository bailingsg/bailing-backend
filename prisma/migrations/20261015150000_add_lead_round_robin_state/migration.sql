-- CreateTable
CREATE TABLE "lead_round_robin_state" (
    "id" TEXT NOT NULL,
    "lastAssigneeId" TEXT,
    "lastIndex" INTEGER NOT NULL DEFAULT -1,
    "cycleCount" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lead_round_robin_state_pkey" PRIMARY KEY ("id")
);


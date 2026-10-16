-- CreateEnum
CREATE TYPE "RoleStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "LeadPlanStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'CLOSED');

-- CreateEnum
CREATE TYPE "LeadAssignmentSource" AS ENUM ('ROUND_ROBIN', 'PRIORITY_PLAN');

-- AlterTable
ALTER TABLE "admin_users" ADD COLUMN     "jobTitle" TEXT;

-- AlterTable
ALTER TABLE "rfqs" ADD COLUMN     "assignedAt" TIMESTAMP(3),
ADD COLUMN     "assigneeId" TEXT;

-- CreateTable
CREATE TABLE "roles" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "RoleStatus" NOT NULL DEFAULT 'ACTIVE',
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "module" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isNav" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "roleId" TEXT NOT NULL,
    "permissionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("roleId","permissionId")
);

-- CreateTable
CREATE TABLE "admin_user_roles" (
    "adminUserId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_user_roles_pkey" PRIMARY KEY ("adminUserId","roleId")
);

-- CreateTable
CREATE TABLE "employee_contacts" (
    "id" TEXT NOT NULL,
    "adminUserId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "jobTitle" TEXT,
    "displayEmail" TEXT,
    "whatsapp" TEXT,
    "showOnSite" BOOLEAN NOT NULL DEFAULT false,
    "isLeadContact" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "internalNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employee_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_distribution_plans" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "LeadPlanStatus" NOT NULL DEFAULT 'ACTIVE',
    "mode" TEXT NOT NULL DEFAULT 'PRIORITY',
    "startAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endAt" TIMESTAMP(3),
    "totalTarget" INTEGER NOT NULL DEFAULT 0,
    "cooldownSeconds" INTEGER NOT NULL DEFAULT 0,
    "closedAt" TIMESTAMP(3),
    "resumeAt" TIMESTAMP(3),
    "closedBy" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lead_distribution_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_distribution_items" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "adminUserId" TEXT NOT NULL,
    "targetCount" INTEGER NOT NULL DEFAULT 0,
    "assignedCount" INTEGER NOT NULL DEFAULT 0,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lead_distribution_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_assignments" (
    "id" TEXT NOT NULL,
    "rfqId" TEXT NOT NULL,
    "assigneeId" TEXT NOT NULL,
    "source" "LeadAssignmentSource" NOT NULL DEFAULT 'ROUND_ROBIN',
    "roundRobinIndex" INTEGER,
    "planId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
    "actorEmail" TEXT,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT,
    "diff" JSONB,
    "summary" TEXT,
    "planId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "roles_key_key" ON "roles"("key");

-- CreateIndex
CREATE INDEX "roles_status_idx" ON "roles"("status");

-- CreateIndex
CREATE INDEX "roles_sortOrder_idx" ON "roles"("sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "permissions_key_key" ON "permissions"("key");

-- CreateIndex
CREATE INDEX "permissions_module_idx" ON "permissions"("module");

-- CreateIndex
CREATE INDEX "permissions_isNav_idx" ON "permissions"("isNav");

-- CreateIndex
CREATE INDEX "role_permissions_permissionId_idx" ON "role_permissions"("permissionId");

-- CreateIndex
CREATE INDEX "admin_user_roles_roleId_idx" ON "admin_user_roles"("roleId");

-- CreateIndex
CREATE UNIQUE INDEX "employee_contacts_adminUserId_key" ON "employee_contacts"("adminUserId");

-- CreateIndex
CREATE INDEX "employee_contacts_showOnSite_idx" ON "employee_contacts"("showOnSite");

-- CreateIndex
CREATE INDEX "employee_contacts_isLeadContact_idx" ON "employee_contacts"("isLeadContact");

-- CreateIndex
CREATE INDEX "employee_contacts_sortOrder_idx" ON "employee_contacts"("sortOrder");

-- CreateIndex
CREATE INDEX "lead_distribution_plans_status_idx" ON "lead_distribution_plans"("status");

-- CreateIndex
CREATE INDEX "lead_distribution_plans_createdAt_idx" ON "lead_distribution_plans"("createdAt");

-- CreateIndex
CREATE INDEX "lead_distribution_items_planId_idx" ON "lead_distribution_items"("planId");

-- CreateIndex
CREATE INDEX "lead_distribution_items_adminUserId_idx" ON "lead_distribution_items"("adminUserId");

-- CreateIndex
CREATE UNIQUE INDEX "lead_distribution_items_planId_adminUserId_key" ON "lead_distribution_items"("planId", "adminUserId");

-- CreateIndex
CREATE INDEX "lead_assignments_rfqId_idx" ON "lead_assignments"("rfqId");

-- CreateIndex
CREATE INDEX "lead_assignments_assigneeId_idx" ON "lead_assignments"("assigneeId");

-- CreateIndex
CREATE INDEX "lead_assignments_source_idx" ON "lead_assignments"("source");

-- CreateIndex
CREATE INDEX "lead_assignments_createdAt_idx" ON "lead_assignments"("createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_actorId_idx" ON "audit_logs"("actorId");

-- CreateIndex
CREATE INDEX "audit_logs_action_idx" ON "audit_logs"("action");

-- CreateIndex
CREATE INDEX "audit_logs_targetType_targetId_idx" ON "audit_logs"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "audit_logs_createdAt_idx" ON "audit_logs"("createdAt");

-- CreateIndex
CREATE INDEX "admin_users_isActive_idx" ON "admin_users"("isActive");

-- CreateIndex
CREATE INDEX "admin_users_role_idx" ON "admin_users"("role");

-- CreateIndex
CREATE INDEX "rfqs_assigneeId_idx" ON "rfqs"("assigneeId");

-- AddForeignKey
ALTER TABLE "rfqs" ADD CONSTRAINT "rfqs_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES "permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_user_roles" ADD CONSTRAINT "admin_user_roles_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_user_roles" ADD CONSTRAINT "admin_user_roles_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_contacts" ADD CONSTRAINT "employee_contacts_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_distribution_items" ADD CONSTRAINT "lead_distribution_items_planId_fkey" FOREIGN KEY ("planId") REFERENCES "lead_distribution_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_distribution_items" ADD CONSTRAINT "lead_distribution_items_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_assignments" ADD CONSTRAINT "lead_assignments_rfqId_fkey" FOREIGN KEY ("rfqId") REFERENCES "rfqs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_assignments" ADD CONSTRAINT "lead_assignments_planId_fkey" FOREIGN KEY ("planId") REFERENCES "lead_distribution_plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_planId_fkey" FOREIGN KEY ("planId") REFERENCES "lead_distribution_plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;


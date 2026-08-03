/** Pure task/project projections shared by the console views. */

export interface ProjectRunOwner {
  id: string;
  name?: string;
  run_names: string[];
}

export interface RunProjectProjection {
  name: string;
  project_id?: string;
  project_name?: string;
}

export interface ActiveProjectJob {
  project_id: string;
}

export type HistoryFilter = "all" | "project" | "unassigned";

/**
 * Prefer task-side project metadata.  ``run_names`` remains a compatibility
 * fallback for old project files/runs that predate the per-run projection.
 */
export function runsForProject<T extends RunProjectProjection>(
  project: ProjectRunOwner,
  runs: T[]
): T[] {
  const legacyNames = new Set(project.run_names);
  return runs.filter((run) =>
    run.project_id?.trim() ? run.project_id === project.id : legacyNames.has(run.name)
  );
}

/** Return the project that owns a run, including the legacy run_names link. */
export function projectForRun<T extends RunProjectProjection, P extends ProjectRunOwner>(
  run: T,
  projects: readonly P[]
): P | undefined {
  const projectId = run.project_id?.trim();
  if (projectId) return projects.find((project) => project.id === projectId);
  return projects.find((project) => project.run_names.includes(run.name));
}

/** A missing/blank project_id is intentionally treated as unassigned. */
export function isUnassignedRun<T extends RunProjectProjection>(run: T): boolean {
  return !run.project_id?.trim();
}

/** Filter historical runs for the task-center history tabs. */
export function runsForHistoryFilter<T extends RunProjectProjection>(
  filter: HistoryFilter,
  project: ProjectRunOwner | undefined,
  runs: T[]
): T[] {
  if (filter === "all") return runs;
  if (filter === "unassigned") return runs.filter(isUnassignedRun);
  return project ? runsForProject(project, runs) : [];
}

/** Display a stable source badge, including project names from legacy links. */
export function projectLabelForRun<T extends RunProjectProjection, P extends ProjectRunOwner>(
  run: T,
  projects: readonly P[]
): string {
  const project = projectForRun(run, projects);
  const projectName = project?.name?.trim();
  if (projectName) return projectName;
  const recordedName = run.project_name?.trim();
  if (recordedName) return recordedName;
  return isUnassignedRun(run) ? "未分配" : "已关联项目";
}

export function activeJobsForProject<T extends ActiveProjectJob>(
  projectId: string,
  jobs: T[]
): T[] {
  return jobs.filter((job) => job.project_id === projectId);
}

/** Pure task/project projections shared by the console views. */

export interface ProjectRunOwner {
  id: string;
  run_names: string[];
}

export interface RunProjectProjection {
  name: string;
  project_id?: string;
}

export interface ActiveProjectJob {
  project_id: string;
}

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
    run.project_id ? run.project_id === project.id : legacyNames.has(run.name)
  );
}

export function activeJobsForProject<T extends ActiveProjectJob>(
  projectId: string,
  jobs: T[]
): T[] {
  return jobs.filter((job) => job.project_id === projectId);
}


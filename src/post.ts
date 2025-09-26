import fs from 'fs/promises'
import path from 'path'
import { v4 as uuidv4 } from 'uuid'
import { DefaultArtifactClient } from '@actions/artifact'
import * as core from '@actions/core'
import * as github from '@actions/github'
import { Octokit } from '@octokit/action'
import * as stepTracer from './stepTracer'
import * as statCollector from './statCollector'
import * as processTracer from './processTracer'
import * as logger from './logger'
import { CompletedCommand, JobInfo, Stats, WorkflowJobType } from './interfaces'

const { pull_request } = github.context.payload
const { workflow, job, repo, runId, sha } = github.context
const PAGE_SIZE = 100
const octokit: Octokit = new Octokit()

async function getCurrentJob(): Promise<WorkflowJobType | null> {
  const _getCurrentJob = async (): Promise<WorkflowJobType | null> => {
    for (let page = 0; ; page++) {
      const result = await octokit.rest.actions.listJobsForWorkflowRun({
        owner: repo.owner,
        repo: repo.repo,
        run_id: runId,
        per_page: PAGE_SIZE,
        page
      })
      const jobs: WorkflowJobType[] = result.data.jobs
      // If there are no jobs, stop here
      if (!jobs || !jobs.length) {
        break
      }
      const currentJobs = jobs.filter(
        it =>
          it.status === 'in_progress' &&
          it.runner_name === process.env.RUNNER_NAME
      )
      if (currentJobs && currentJobs.length) {
        return currentJobs[0]
      }
      // Since returning job count is less than page size, this means that there are no other jobs.
      // So no need to make another request for the next page.
      if (jobs.length < PAGE_SIZE) {
        break
      }
    }
    return null
  }
  try {
    for (let i = 0; i < 10; i++) {
      const currentJob: WorkflowJobType | null = await _getCurrentJob()
      if (currentJob && currentJob.id) {
        return currentJob
      }
      await new Promise(r => setTimeout(r, 1000))
    }
  } catch (error: any) {
    logger.error(
      `Unable to get current workflow job info. ` +
        `Please sure that your workflow have "actions:read" permission!`
    )
  }
  return null
}

async function reportAll(
  currentJob: WorkflowJobType,
  content: string
): Promise<void> {
  logger.info(`Reporting all content ...`)

  logger.debug(`Workflow - Job: ${workflow} - ${job}`)

  const jobUrl = `https://github.com/${repo.owner}/${repo.repo}/runs/${currentJob.id}?check_suite_focus=true`
  logger.debug(`Job url: ${jobUrl}`)

  const title = `## Workflow Telemetry - ${workflow} / ${currentJob.name}`
  logger.debug(`Title: ${title}`)

  const commit: string =
    (pull_request && pull_request.head && pull_request.head.sha) || sha
  logger.debug(`Commit: ${commit}`)

  const commitUrl = `https://github.com/${repo.owner}/${repo.repo}/commit/${commit}`
  logger.debug(`Commit url: ${commitUrl}`)

  const info =
    `Workflow telemetry for commit [${commit}](${commitUrl})\n` +
    `You can access workflow job details [here](${jobUrl})`

  const postContent: string = [title, info, content].join('\n')

  const jobSummary: string = core.getInput('job_summary')
  if ('true' === jobSummary) {
    core.summary.addRaw(postContent)
    await core.summary.write()
  }

  const commentOnPR: string = core.getInput('comment_on_pr')
  if (pull_request && 'true' === commentOnPR) {
    if (logger.isDebugEnabled()) {
      logger.debug(`Found Pull Request: ${JSON.stringify(pull_request)}`)
    }

    await octokit.rest.issues.createComment({
      ...github.context.repo,
      issue_number: Number(github.context.payload.pull_request?.number),
      body: postContent
    })
  } else {
    logger.debug(`Couldn't find Pull Request`)
  }

  logger.info(`Reporting all content completed`)
}

async function uploadAllArtifacts(
  currentJob: WorkflowJobType,
  jobInfo: JobInfo | null,
  stats: Stats | null,
  commands: CompletedCommand[] | null
): Promise<void> {
  const saveRawStats: boolean = core.getBooleanInput('save_raw_stats')
  if (!saveRawStats) return

  let artifactFiles: string[] = []
  const rootDirectory = path.join(__dirname, '../')
  if (jobInfo !== null) {
    const outFilePath = path.join(rootDirectory, 'steps-trace.json')
    try {
      await fs.writeFile(outFilePath, JSON.stringify(jobInfo))
      logger.info(`Step tracer stats saved to ${outFilePath}`)
      artifactFiles.push(outFilePath)
    } catch (err: any) {
      logger.error(`Failed to save Step tracer stats to ${outFilePath}`)
      logger.error(err)
    }
  }
  if (stats !== null) {
    const outFilePath = path.join(rootDirectory, 'stats.json')
    try {
      await fs.writeFile(outFilePath, JSON.stringify(stats))
      logger.info(`System stats saved to ${outFilePath}`)
      artifactFiles.push(outFilePath)
    } catch (err: any) {
      logger.error(`Failed to save System stats to ${outFilePath}`)
      logger.error(err)
    }
  }
  if (commands !== null) {
    const outFilePath = path.join(rootDirectory, 'procs-trace.json')
    try {
      await fs.writeFile(outFilePath, JSON.stringify(commands))
      logger.info(`Process tracer stats saved to ${outFilePath}`)
      artifactFiles.push(outFilePath)
    } catch (err: any) {
      logger.error(`Failed to save Process tracer stats to ${outFilePath}`)
      logger.error(err)
    }
  }

  if (artifactFiles.length === 0) {
    logger.info('No artifact to upload')
    return
  }

  const artifact = new DefaultArtifactClient()
  const retentionDays = parseInt(core.getInput('artifact_retention_days'))
  const artifactName = `stats_${github.context.runId}_${github.context.runNumber}_${github.context.job}_${uuidv4()}`
  await artifact
    .uploadArtifact(artifactName, artifactFiles, rootDirectory, {
      retentionDays
    })
    .then(() => {
      logger.info(`Stats artifact ${artifactName} uploaded`)
    })
    .catch((error: any) => {
      logger.error(`Failed to upload ${artifactName} stats artifact`)
      logger.error(error)
    })
}

async function run(): Promise<void> {
  try {
    logger.info(`Finishing ...`)

    const currentJob: WorkflowJobType | null = await getCurrentJob()

    if (!currentJob) {
      logger.error(
        `Couldn't find current job. So action will not report any data.`
      )
      return
    }

    logger.debug(`Current job: ${JSON.stringify(currentJob)}`)

    // Finish step tracer
    await stepTracer.finish(currentJob)
    // Finish stat collector
    await statCollector.finish(currentJob)
    // Finish process tracer
    await processTracer.finish(currentJob)

    // Report step tracer
    const [stepTracerStats, stepTracerContent] =
      await stepTracer.report(currentJob)
    // Report stat collector
    const [stepCollectorStats, stepCollectorContent] =
      await statCollector.report(currentJob)
    // Report process tracer
    const [procTracerStats, procTracerContent] =
      await processTracer.report(currentJob)

    let allContent = ''

    if (stepTracerContent) {
      allContent = allContent.concat(stepTracerContent, '\n')
    }
    if (stepCollectorContent) {
      allContent = allContent.concat(stepCollectorContent, '\n')
    }
    if (procTracerContent) {
      allContent = allContent.concat(procTracerContent, '\n')
    }

    await reportAll(currentJob, allContent)
    await uploadAllArtifacts(
      currentJob,
      stepTracerStats,
      stepCollectorStats,
      procTracerStats
    )

    logger.info(`Finish completed`)
  } catch (error: any) {
    logger.error(error.message)
  }
}

run()

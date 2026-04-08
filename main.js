#!/usr/bin/env node
//@ts-check

import assert from "assert"
import { ScreepsAPI } from "screeps-api"
import * as jsonquery from "@jsonquerylang/jsonquery"
import he from "he"
import { request as httpRequest } from "http"
import { request as httpsRequest } from "https"

const { SCREEPS_SERVER, SCREEPS_SERVER_HOST } = process.env
assert(SCREEPS_SERVER, "You must specify SCREEPS_SERVER environment variable")

const opts = SCREEPS_SERVER_HOST ? { hostname: SCREEPS_SERVER_HOST } : undefined
const api = await ScreepsAPI.fromConfig(SCREEPS_SERVER, "exporter", opts)

/**
 * Get a configuration value from environment variables or config file.
 * @param {string} name in UPPER_SNAKE_CASE
 * @param {boolean} optional
 * @returns {string}
 */
function getConfigValue(name, optional = false) {
  const envName = name.toUpperCase()
  const envVar = process.env[envName]
  if (envVar !== undefined) return envVar

  if (api.appConfig?.exporter) {
    const configName = name.split("_").reduce((acc, part) => {
      if (acc === "") return part.toLowerCase()
      return acc + part.charAt(0) + part.slice(1).toLowerCase()
    }, "")
    const configValue = api.appConfig?.exporter?.[configName]
    if (configValue !== undefined) return configValue
  }

  if (!optional) throw new Error(`You must specify ${envName} environment variable`)
  return ""
}

const CONSOLE_QUERY = getConfigValue("CONSOLE_QUERY")
const pushGatewayUrl = new URL(getConfigValue("PUSHGATEWAY"))
const TIMESTAMPS_QUERY = getConfigValue("TIMESTAMPS_QUERY", true) || "null"
const METRICS_SEPARATOR = getConfigValue("METRICS_SEPARATOR", true) || "."

/** @type {import('http').ClientRequest | null} */
let req = null
function getStreamingConnection() {
  if (req) return req
  const request = pushGatewayUrl.protocol === "https:" ? httpsRequest : httpRequest
  req = request(pushGatewayUrl, { method: "POST" }, (res) => {
    console.warn("go response", res)
    res.resume()
  })
  req.on("error", (err) => {
    console.error("Pushgateway error", err)
    req = null
  })
  req.on("end", () => {
    console.warn("Pushgateway connection ended")
    req = null
  })
  return req
}

/** @param {object} labels */
const formatLabels = (labels) =>
  labels
    ? Object.entries(labels)
        .map(([k, v]) => `${k}="${v}"`)
        .join(",")
    : ""
/**
 * @param {string} a
 * @param {string} b
 */
const concatStrs = (a, b, sep = ",") => (a ? (b ? `${a}${sep}${b}` : a) : b || "")

let hasLoggedOverflow = false
/**
 * Write a single metric to the Pushgateway stream
 * @param {string} key
 * @param {number} value
 * @param {string} globalLabelsStr
 * @param {number | undefined} timestamp milliseconds since the Unix epoch, or undefined to use the time of ingestion as the timestamp
 */
function pushMetric(key, value, globalLabelsStr = "", timestamp = undefined) {
  const line = `${key}{${globalLabelsStr}} ${value}${timestamp !== undefined ? ` ${timestamp}` : ""}\n`
  const success = getStreamingConnection().write(line)
  if (!hasLoggedOverflow && !success) {
    hasLoggedOverflow = true
    console.error(
      "Pushgateway stream buffer overflow, metrics may be lost. Consider increasing the buffer size or reducing the frequency of metrics.",
    )
  }
}
/**
 * Write metrics from a nested object to the Pushgateway stream
 * @param {object} data
 * @param {number | undefined} timestamp
 */
function pushMetricsRec(data, prefix = "", globalLabelsStr = "", timestamp = undefined) {
  for (const [key, value] of Object.entries(data)) {
    const metricKey = prefix + key
    if (typeof value === "number") {
      //MAYBE: extract additional metric-specific labels
      pushMetric(metricKey, value, globalLabelsStr, timestamp)
    } else if (typeof value === "object") {
      pushMetricsRec(value, metricKey + METRICS_SEPARATOR, globalLabelsStr, timestamp)
    }
  }
}

/**
 * @param {string} str
 * @returns {(data: object) => any}
 */
function compileJsonQuery(str) {
  try {
    return jsonquery.compile(jsonquery.parse(str))
  } catch (err) {
    console.error("Failed to compile JSON query", str)
    throw err
  }
}

const getTimestamps = compileJsonQuery(TIMESTAMPS_QUERY)
/**
 * Extract timestamps from the given data using the TIMESTAMPS_QUERY.
 * @param {object} data
 * @returns {[string | undefined, number | undefined][]} An array of [unit, timestamp] pairs
 */
function extractTimestamps(data) {
  const timestamps = getTimestamps(data)
  if (timestamps === undefined || timestamps === null) {
    return [[undefined, undefined]]
  } else if (Array.isArray(timestamps)) {
    return timestamps.map((ts) => [undefined, ts])
  } else if (typeof timestamps === "object") {
    return Object.entries(timestamps)
  } else {
    console.warn(
      "Invalid timestamps format returned by TIMESTAMPS_QUERY, expected array, object or undefined",
    )
    return [[undefined, undefined]]
  }
}

/** @param {object} data */
function pushMetrics(data, labels = {}) {
  //MAYBE: extract additional global labels
  const globalLabelsStr = formatLabels(labels)

  for (const [unit, timestamp] of extractTimestamps(data)) {
    const timeLabel = unit ? `time="${unit}"` : ""
    pushMetricsRec(data, "", concatStrs(globalLabelsStr, timeLabel), timestamp)
  }
}

api.socket.on("error", console.error)

if (CONSOLE_QUERY) {
  const isConsoleQuery = compileJsonQuery(CONSOLE_QUERY)

  api.socket
    .subscribe("console", ({ data }) => {
      if (!("messages" in data)) return

      const labels = data.shard ? { shard: data.shard } : {}
      for (const rawStr of data.messages.log) {
        if (!rawStr.startsWith("{")) continue
        const str = he.decode(rawStr)
        try {
          const obj = JSON.parse(str)
          const result = isConsoleQuery(obj)
          if (result) pushMetrics(typeof result === "object" ? result : obj, labels)
        } catch {}
      }
    })
    .catch(() => {})
  await api.socket.connect()
}

const close = () => {
  console.log("Closing connections...")
  api.socket.disconnect()
  req?.end()
}
process.on("SIGINT", close)
process.on("SIGTERM", close)

//MAYBE: subscribe to other data sources (like memory or segments)

console.log("Connected to Screeps server, streaming metrics...")

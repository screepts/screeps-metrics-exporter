# Screeps Metrics Exporter

This is a real-time Prometheus exporter for Screeps metrics. It collects data from the Screeps API and exposes it in a format that Prometheus can import.

Features:

- Use [.screeps.yml](https://github.com/screepers/screepers-standards/blob/master/SS3-Unified_Credentials_File.md)
- Collects metrics from Console
  - No rate limits leading to missing data
- Convert to Prometheus format
- Export to [Pushgateway](https://github.com/prometheus/pushgateway)
- Streaming for real-time updates

In your Screeps bot, you can log metrics as JSON objects to the console. For example:

```javascript
console.log(JSON.stringify({
  cpu: Game.cpu.getUsed(),
  gcl: {
    progressTotal: Game.gcl.progressTotal,
  }
  up: 1 // custom field used to filter logs for metrics
}))
```

It will be collected by the exporter and sent to Prometheus with `cpu` and `gcl.progressTotal` as metric names.

## Usage

```sh
export SCREEPS_SERVER=main
export CONSOLE_QUERY=".up==1"
export PUSHGATEWAY=http://localhost:8428/api/v1/import/prometheus/metrics/job/screeps_main
npx @screepts/screeps-metrics-exporter
```

### Docker

You can use the provided `docker-compose.yml` to run the exporter along with VictoriaMetrics

```yaml
services:
  victoriametrics:
    image: victoriametrics/victoria-metrics
    ports:
      - 8428:8428

  screeps-exporter:
    image: ghcr.io/screepts/screeps-metrics-exporter
    depends_on:
      - victoriametrics
    restart: unless-stopped
    volumes:
      - ./.screeps.yml:/.screeps.yml:ro
    environment:
      SCREEPS_SERVER: main
      CONSOLE_QUERY: .up==1 # Every log with a JSON object containing "up": 1 will be collected as a metric
      PUSHGATEWAY: http://victoriametrics:8428/api/v1/import/prometheus/metrics/job/screeps_main
```

```bash
docker compose up -d
```

### Custom Setup

- Clone the repository
- Install dependencies with `npm install`
- Run the exporter with `SCREEPS_SERVER=main node main.js`

## Configuration

The exporter can be configured using environment variables or `exporter` config in `.screeps.yml` as follows:

```yaml
server:
  main:
    host: screeps.com
    # ... server config
configs:
  exporter:
    # Equivalent to setting PUSHGATEWAY environment variable
    pushGateway: http://victoriametrics:8428/api/v1/import/prometheus
```

### Server Configuration

Screeps server credentials are stored in `/.screeps.yml`. No credentials are exposed in environment variables.

- `SCREEPS_SERVER`: Required to specify which server to connect to.
- `SCREEPS_SERVER_HOST`: Optional, override the hostname from config. Useful when set to `host.docker.internal` in Docker to connect to a host local server.

### Inputs

#### Console Logs

- `CONSOLE_QUERY`: Required, a [JSON Query](https://github.com/jsonquerylang/jsonquery) that matches metrics in the console logs.
  - For example, if you want to collect metrics from logs that contain a JSON object with `"up": 1`, you can set `CONSOLE_QUERY=.up==1`.
  - The query can also transform the data
    - For example `if(.up==1, {cpu: .cpu * 100}, false)` will convert the `cpu` field to a percentage if the log contains `up: 1`.

### Transformation

- `TIMESTAMPS_QUERY`: Optional, a [JSON Query](https://github.com/jsonquerylang/jsonquery) that extracts timestamps from the data. The query should return an array of timestamps in milliseconds since the Unix epoch.
  - Default value (`null`) means no timestamps will be attached to the metrics, and Prometheus will use the time of ingestion as the timestamp.
  - If multiple timestamps are returned, the metrics will be pushed with each timestamp.
  - If an object is returned, keys will be used as label `time` and valuesas timestamps.
    - For example `{utc: null, tick: .time}` will attach both the current UTC time and the game tick as timestamps to the metrics, with labels `time="utc"` and `time="tick"` respectively.
- `METRICS_SEPARATOR`: Optional, the separator used to convert JSON path to metric key. Default to `.` like JSON path and Graphite naming convention. Can be set to `_` to use Prometheus naming convention.

### Pushgateway

Prometheus Pushgateway is used to receive metrics from the exporter. You can use any URL that supports Prometheus format, such as VictoriaMetrics.

- `PUSHGATEWAY`: Required to specify the Pushgateway URL to export metrics to.

import axios from 'axios';
import * as schedule from 'node-schedule';
import {LOGGER} from '../constant';
import {sendObjToDiscord} from './discord';
import {
  defaultTarget,
  Endpoint,
  EndpointHealth,
  endpoints,
  EndpointStability,
  statusCode200,
} from './endpoints';

const theLatestThree: {
  timestamp: number;
  health: EndpointHealth[];
}[] = [];
let currentOffset = 0;
const stability = {} as EndpointStability;

function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function checkingUrls(endpoint: Endpoint) {
  if (endpoint.name === 'Gas estimator API') {
    await delay(5500);
  }
  const urlsHealth: {url: string; health: boolean; responseTime: number}[] = [];
  const urlCheckers = endpoint.urls.map(async (url: string) => {
    let promise: any;
    const startedTime = Number(new Date());
    if (!endpoint.preprocess) {
      promise = await axios.get(url);
    } else {
      const result = endpoint.preprocess(url);
      if (result.method === 'get') {
        promise = await axios.get(result.url, result.config);
      } else {
        promise = await axios.post(result.url, result.data, result.config);
      }
    }
    const finishedTime = Number(new Date());
    return {data: promise, responseTime: finishedTime - startedTime};
  });
  const results = await Promise.allSettled(urlCheckers);
  results.forEach((result, index) => {
    if (!stability[endpoint.urls[index]]) stability[endpoint.urls[index]] = 0;
    if (result.status === 'rejected') {
      stability[endpoint.urls[index]]++;
      urlsHealth.push({
        url: endpoint.urls[index],
        health: false,
        responseTime: -1,
      });
    } else {
      if (stability[endpoint.urls[index]] > 0)
        stability[endpoint.urls[index]]--;
      urlsHealth.push({
        url: endpoint.urls[index],
        health: endpoint.expected
          ? endpoint.expected(result.value.data)
          : statusCode200(result.value.data),
        responseTime: result.value.responseTime,
      });
    }
  });
  return urlsHealth;
}

export async function checking() {
  const endpointsHealth: EndpointHealth[] = [];
  const checkers = endpoints.map(checkingUrls);
  const results = await Promise.allSettled(checkers);
  results.forEach((result, index) => {
    const endpoint = endpoints[index];
    if (result.status === 'rejected') {
      endpointsHealth.push({
        name: endpoint.name,
        urls: endpoint.urls.map(url => {
          return {url, health: false, responseTime: -1};
        }),
        target: endpoints[index].target || defaultTarget,
      });
    } else {
      endpointsHealth.push({
        name: endpoint.name,
        urls: result.value,
        target: endpoints[index].target || defaultTarget,
      });
    }
  });
  return endpointsHealth;
}

async function collectCheckingResults() {
  const health = await checking();
  if (theLatestThree.length < 3) {
    theLatestThree.push({timestamp: new Date().getTime(), health});
  } else {
    theLatestThree[currentOffset] = {timestamp: new Date().getTime(), health};
    currentOffset = (currentOffset + 1) % 3;
  }
}

// we found some services are not stable. so to reduce false positive:
// 1. we collect the latest three results.
// 2. the final health of a service = result1 || result2 || result3
//    which means only continuous 3 false results will cause a real false result.

export function generateFinalMonitorReport() {
  if (theLatestThree.length !== 3) {
    return {timestamp: null, health: null};
  }
  const timestamp = Math.max(
    Math.max(theLatestThree[0].timestamp, theLatestThree[1].timestamp),
    theLatestThree[2].timestamp
  );

  const finalHealth: EndpointHealth[] = [];
  theLatestThree[0].health.forEach((health, index1) => {
    const name = health.name;
    const target = health.target;
    const urls = health.urls.map((url, index2) => {
      let responseTime = 0;
      let count = 0;
      theLatestThree.map(theLatestItem => {
        if (theLatestItem.health[index1].urls[index2].health) {
          responseTime +=
            theLatestItem.health[index1].urls[index2].responseTime;
          count++;
        }
      });
      return {
        url: url.url,
        health:
          url.health ||
          theLatestThree[1].health[index1].urls[index2].health ||
          theLatestThree[2].health[index1].urls[index2].health,
        responseTime: count === 0 ? -1 : responseTime / count,
      };
    });
    return finalHealth.push({name, target, urls});
  });
  return {timestamp, health: finalHealth, stability};
}

export function sendUnhealthyServicesReports(
  endpointsHealth: EndpointHealth[] | null
) {
  if (!endpointsHealth) {
    return;
  }

  const reports: {[key: string]: {name: string; url: string}[]} = {};
  endpointsHealth.forEach(endpoint => {
    const unhealthyUrls = endpoint.urls.filter(url => !url.health);
    if (unhealthyUrls && unhealthyUrls.length) {
      unhealthyUrls.forEach(url => {
        if (!reports[endpoint.target]) {
          reports[endpoint.target] = [];
        }
        reports[endpoint.target].push({name: endpoint.name, url: url.url});
      });
    }
  });

  Object.keys(reports).forEach(key => {
    sendObjToDiscord('Unavaliable Services', reports[key], key);
  });
}

export function collectAndNotify() {
  LOGGER.info('Started collectAndNotify');
  collectCheckingResults();
  sendUnhealthyServicesReports(generateFinalMonitorReport().health);
}

export function scheduleCheckingEveryFiveMinutes() {
  schedule.scheduleJob('*/5 * * * *', collectAndNotify);
}

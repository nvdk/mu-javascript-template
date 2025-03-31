import httpContext from 'express-http-context';
import env from 'env-var';
import SPARQL from './sparql-tag';
import DigestFetch from "digest-fetch";

const LOG_SPARQL_QUERIES = process.env.LOG_SPARQL_QUERIES != undefined ? env.get('LOG_SPARQL_QUERIES').asBool() : env.get('LOG_SPARQL_ALL').asBool();
const LOG_SPARQL_UPDATES = process.env.LOG_SPARQL_UPDATES != undefined ? env.get('LOG_SPARQL_UPDATES').asBool() : env.get('LOG_SPARQL_ALL').asBool();
const DEBUG_AUTH_HEADERS = env.get('DEBUG_AUTH_HEADERS').asBool();
const MU_SPARQL_ENDPOINT = env.get('MU_SPARQL_ENDPOINT').default('http://database:8890/sparql').asString();
const RETRY = env.get('MU_QUERY_RETRY').default('false').asBool();
const RETRY_MAX_ATTEMPTS = env.get('MU_QUERY_RETRY_MAX_ATTEMPTS').default('5').asInt();
const RETRY_FOR_HTTP_STATUS_CODES = env.get('MU_QUERY_RETRY_FOR_HTTP_STATUS_CODES').default('').asArray();
const RETRY_FOR_CONNECTION_ERRORS = env.get('MU_QUERY_RETRY_FOR_CONNECTION_ERRORS').default('ECONNRESET,ETIMEDOUT,EAI_AGAIN').asArray();
const RETRY_TIMEOUT_INCREMENT_FACTOR = env.get('MU_QUERY_RETRY_TIMEOUT_INCREMENT_FACTOR').default('0.1').asFloat();

//==-- logic --==//

/**
 * Executes a SPARQL query against a given endpoint (you can use the template syntax).
 *
 * @param {string} queryString - The SPARQL query to execute.
 * @param {object} [options={}] - Optional parameters for query execution.
 * @param {string} [options.sparqlEndpoint=MU_SPARQL_ENDPOINT] - The SPARQL endpoint to send the request to.
 * @param {boolean} [options.sudo=false] - Whether to include the 'mu-auth-sudo' header.
 * @param {string} [options.scope] - Authentication scope to use. Falls back to DEFAULT_MU_AUTH_SCOPE if not provided.
 * @param {object} [options.extraHeaders={}] - Additional headers to include in the request.
 * @param {string} [options.authUser] - Username for HTTP authentication.
 * @param {string} [options.authPassword] - Password for HTTP authentication.
 * @param {"basic"|"digest"} [options.authType="digest"] - Type of HTTP authentication (default is digest).
 * @returns {Promise<any>} - The parsed JSON response from the SPARQL endpoint.
 * @throws {Error} - Throws an error if the request fails and cannot be retried.
 */
function query( queryString, options = {} ) {
  if (LOG_SPARQL_QUERIES) {
    console.log(queryString);
  }
  return executeQuery(queryString, options);
};

/**
 * Executes a SPARQL query against a given endpoint (you can use the template syntax).
 *
 * @param {string} queryString - The SPARQL query to execute.
 * @param {object} [options={}] - Optional parameters for query execution.
 * @param {string} [options.sparqlEndpoint=MU_SPARQL_ENDPOINT] - The SPARQL endpoint to send the request to.
 * @param {boolean} [options.sudo=false] - Whether to include the 'mu-auth-sudo' header.
 * @param {string} [options.scope] - Authentication scope to use. Falls back to DEFAULT_MU_AUTH_SCOPE if not provided.
 * @param {object} [options.extraHeaders={}] - Additional headers to include in the request.
 * @param {string} [options.authUser] - Username for HTTP authentication.
 * @param {string} [options.authPassword] - Password for HTTP authentication.
 * @param {"basic"|"digest"} [options.authType="digest"] - Type of HTTP authentication (default is digest).
 * @returns {Promise<any>} - The parsed JSON response from the SPARQL endpoint.
 * @throws {Error} - Throws an error if the request fails and cannot be retried.
 */
function update(queryString, options = {}) {
  if (LOG_SPARQL_UPDATES) {
    console.log(queryString);
  }
  return executeQuery(queryString, options);
};

function defaultHeaders() {
  const headers = new Headers();
  headers.set("content-type", "application/x-www-form-urlencoded");
  headers.set("Accept", "application/sparql-results+json");
  if (httpContext.get("request")) {
    headers.set(
      "mu-session-id",
      httpContext.get("request").get("mu-session-id")
    );
    headers.set("mu-call-id", httpContext.get("request").get("mu-call-id"));
  }
  return headers;
}

/**
 * Executes a SPARQL query against a given endpoint.
 *
 * @param {string} queryString - The SPARQL query to execute.
 * @param {object} [options={}] - Optional parameters for query execution.
 * @param {string} [options.sparqlEndpoint=MU_SPARQL_ENDPOINT] - The SPARQL endpoint to send the request to.
 * @param {boolean} [options.sudo=false] - Whether to include the 'mu-auth-sudo' header.
 * @param {string} [options.scope] - Authentication scope to use. Falls back to DEFAULT_MU_AUTH_SCOPE if not provided.
 * @param {object} [options.extraHeaders={}] - Additional headers to include in the request.
 * @param {string} [options.authUser] - Username for HTTP authentication.
 * @param {string} [options.authPassword] - Password for HTTP authentication.
 * @param {"basic"|"digest"} [options.authType="digest"] - Type of HTTP authentication (default is digest).
 * @param {number} [attempt=0] - Current retry attempt.
 * @returns {Promise<any>} - The parsed JSON response from the SPARQL endpoint.
 * @throws {Error} - Throws an error if the request fails and cannot be retried.
 */
async function executeQuery(queryString, options = {}, attempt = 0)
{
  const sparqlEndpoint = options.sparqlEndpoint ?? MU_SPARQL_ENDPOINT;
  const headers = defaultHeaders();

  const extraHeaders = options.extraHeaders ?? {};
  for (const key of Object.keys(extraHeaders)) {
    headers.append(key, options.extraHeaders[key]);
  }
  if (options.sudo === true) {
    if (env.get("ALLOW_MU_AUTH_SUDO").asBool()) {
      headers.set('mu-auth-sudo', "true");
    }
    else {
      throw new Error("Error, sudo request but service lacks ALLOW_MU_AUTH_SUDO header");
    }
  }

  if (options.scope) {
    headers.set('mu-auth-scope', options.scope);
  } else if (env.get("DEFAULT_MU_AUTH_SCOPE")) {
    headers.set('mu-auth-scope', env.get("DEFAULT_MU_AUTH_SCOPE"));
  }

  if (DEBUG_AUTH_HEADERS) {
    const stringifiedHeaders = Array.from(headers.entries())
      .filter(([key]) => key.startsWith("mu-"))
      .map(([key, value]) => `${key}: ${value}`)
      .join("\n");
    console.log(`Headers set on SPARQL client: ${stringifiedHeaders}`);
  }

  try {
    // note that URLSearchParams is used because it correctly encodes for form-urlencoded
    const formData = new URLSearchParams();
    formData.set("query", queryString);
    headers.append("Content-Length", formData.toString().length.toString());

    let response;
    if (options.authUser && options.authPassword) {
      const client = new DigestFetch(
        options.authUser,
        options.authPassword,
        { basic: options.authType === "basic" }
      );
      response = await client.fetch(sparqlEndpoint, {
        method: "POST",
        body: formData.toString(),
        headers,
      });
    } else {
      response = await fetch(sparqlEndpoint, {
        method: "POST",
        body: formData.toString(),
        headers,
      });
    }
    updateResponseHeaders(response);
    if (response.ok) {
      return await maybeJSON(response);
    } else {
      throw new Error(`HTTP Error Response: ${response.status} ${response.statusText}`);
    }
  } catch (ex) {
    if (mayRetry(ex, attempt, options)) {
      attempt += 1;

      const sleepTime = nextAttemptTimeout(attempt);
      console.log(`Sleeping ${sleepTime} ms before next attempt`);
      await new Promise((r) => setTimeout(r, sleepTime));

      return await executeQuery(
        queryString,
        options,
        attempt
      );
    } else {
      console.log(`Failed Query:
                  ${queryString}`);
      throw ex;
    }
  }
}

function updateResponseHeaders(response){
  // update the outgoing response headers with the headers received from the SPARQL endpoint
  if (httpContext.get('response') && !httpContext.get('response').headersSent) {
    // set mu-auth-allowed-groups on outgoing response
    const allowedGroups = response.headers.get('mu-auth-allowed-groups');
    if (allowedGroups) {
      httpContext.get('response').setHeader('mu-auth-allowed-groups', allowedGroups);
      if (DEBUG_AUTH_HEADERS) {
        console.log(`Update mu-auth-allowed-groups to ${allowedGroups}`);
      }
    } else {
      httpContext.get('response').removeHeader('mu-auth-allowed-groups');
      if (DEBUG_AUTH_HEADERS) {
        console.log('Remove mu-auth-allowed-groups');
      }
    }

    // set mu-auth-used-groups on outgoing response
    const usedGroups = response.headers.get('mu-auth-used-groups');
    if (usedGroups) {
      httpContext.get('response').setHeader('mu-auth-used-groups', usedGroups);
      if (DEBUG_AUTH_HEADERS) {
        console.log(`Update mu-auth-used-groups to ${usedGroups}`);
      }
    } else {
      httpContext.get('response').removeHeader('mu-auth-used-groups');
      if (DEBUG_AUTH_HEADERS) {
        console.log('Remove mu-auth-used-groups');
      }
    }
  }
}

async function maybeJSON(response) {
  try {
    return await response.json();
  } catch (e) {
    return null;
  }
}

function mayRetry(
  error,
  attempt,
  connectionOptions = {}
) {
  console.log(
    `Checking retry allowed for error: ${error} and attempt: ${attempt}`
  );

  let mayRetry = false;

  if (!(RETRY || connectionOptions.mayRetry)) {
    mayRetry = false;
  } else if (attempt < RETRY_MAX_ATTEMPTS) {
    if (error.code && RETRY_FOR_CONNECTION_ERRORS.includes(error.code)) {
      mayRetry = true;
    } else if ( error.httpStatus && RETRY_FOR_HTTP_STATUS_CODES.includes(`${error.httpStatus}`) ) {
      mayRetry = true;
    }
  }

  console.log(`Retry allowed? ${mayRetry}`);

  return mayRetry;
}

function nextAttemptTimeout(attempt) {
  // expected to be milliseconds
  return Math.round(RETRY_TIMEOUT_INCREMENT_FACTOR * Math.exp(attempt + 10));
}

function sparqlEscapeString( value ){
  return '"""' + value.replace(/[\\"]/g, function(match) { return '\\' + match; }) + '"""';
};

function sparqlEscapeUri( value ){
  return '<' + value.replace(/[\\"<>]/g, function(match) { return '\\' + match; }) + '>';
};

function sparqlEscapeDecimal( value ){
  return '"' + Number.parseFloat(value) + '"^^xsd:decimal';
};

function sparqlEscapeInt( value ){
  return '"' + Number.parseInt(value) + '"^^xsd:integer';
};

function sparqlEscapeFloat( value ){
  return '"' + Number.parseFloat(value) + '"^^xsd:float';
};

function sparqlEscapeDate( value ){
  return '"' + new Date(value).toISOString().substring(0, 10) + '"^^xsd:date'; // only keep 'YYYY-MM-DD' portion of the string
};

/**
 * Escape date string or date object into an xsd:dateTime for use in a SPARQL string.
 *
 * @param { Date | string | number } value Date representation
 * (understood by `new Date`) to convert.
 * @return { string } Date representation for SPARQL query.
 */
function sparqlEscapeDateTime( value ){
  return '"' + new Date(value).toISOString() + '"^^xsd:dateTime';
};

/**
 * Escape boolean-like value into xsd:boolean for use in a SPARQL string.
 *
 * @param { any } value Boolean-like value, anything javascript finds truethy is true.
 * @return { string } Boolean representation for SPARQL query.
 */
function sparqlEscapeBool( value ){
  return value ? '"true"^^xsd:boolean' : '"false"^^xsd:boolean';
};

function sparqlEscape( value, type ){
  switch(type) {
  case 'string':
    return sparqlEscapeString(value);
  case 'uri':
    return sparqlEscapeUri(value);
  case 'bool':
    return sparqlEscapeBool(value);
  case 'decimal':
    return sparqlEscapeDecimal(value);
  case 'int':
    return sparqlEscapeInt(value);
  case 'float':
    return sparqlEscapeFloat(value);
  case 'date':
    return sparqlEscapeDate(value);
  case 'dateTime':
    return sparqlEscapeDateTime(value);
  default:
    console.error(`WARN: Unknown escape type '${type}'. Escaping as string`);
    return sparqlEscapeString(value);
  }
}

//==-- exports --==//
const exports = {
  SPARQL: SPARQL,
  sparql: SPARQL,
  query: query,
  update: update,
  sparqlEscape: sparqlEscape,
  sparqlEscapeString: sparqlEscapeString,
  sparqlEscapeUri: sparqlEscapeUri,
  sparqlEscapeDecimal: sparqlEscapeDecimal,
  sparqlEscapeInt: sparqlEscapeInt,
  sparqlEscapeFloat: sparqlEscapeFloat,
  sparqlEscapeDate: sparqlEscapeDate,
  sparqlEscapeDateTime: sparqlEscapeDateTime,
  sparqlEscapeBool: sparqlEscapeBool
}
export default exports;

export {
  SPARQL as SPARQL,
  SPARQL as sparql,
  query,
  update,
  sparqlEscape,
  sparqlEscapeString,
  sparqlEscapeUri,
  sparqlEscapeDecimal,
  sparqlEscapeInt,
  sparqlEscapeFloat,
  sparqlEscapeDate,
  sparqlEscapeDateTime,
  sparqlEscapeBool
};

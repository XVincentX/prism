import { IHttpCallbackOperation, IHttpOperationRequest, Dictionary } from '@stoplight/types';
import { resolveRuntimeExpressions } from '../../utils/runtimeExpression';
import { IHttpRequest, IHttpResponse } from '../../types';
import fetch from 'node-fetch';
import * as O from 'fp-ts/lib/Option';
import * as E from 'fp-ts/lib/Either';
import * as A from 'fp-ts/lib/Array';
import { Do } from 'fp-ts-contrib/lib/Do';
import * as TE from 'fp-ts/lib/TaskEither';
import * as RTE from 'fp-ts/lib/ReaderTaskEither';
import { head } from 'fp-ts/lib/Array';
import { pipe } from 'fp-ts/lib/pipeable';
import { fromPairs } from 'lodash';
import { generate as generateHttpParam } from '../generator/HttpParamGenerator';
import { validateOutput } from '../../validator';
import { parseResponse } from '../../utils/parseResponse';
import { violationLogger } from '../../utils/logger';
import { Logger } from 'pino';

const sequenceOption = A.array.sequence(O.option);

export function runCallback({
  callback,
  request,
  response,
}: {
  callback: IHttpCallbackOperation;
  request: IHttpRequest;
  response: IHttpResponse;
}): RTE.ReaderTaskEither<Logger, void, unknown> {
  return logger => {
    const { url, requestData } = assembleRequest({ resource: callback, request, response });
    const logViolation = violationLogger(logger);

    logger.info({ name: 'CALLBACK' }, `${callback.callbackName}: Making request to ${url}...`);

    return pipe(
      TE.tryCatch(() => fetch(url, requestData), E.toError),
      TE.chain(parseResponse),
      TE.mapLeft(error =>
        logger.error({ name: 'CALLBACK' }, `${callback.callbackName}: Request failed: ${error.message}`)
      ),
      TE.chain(element => {
        logger.info({ name: 'CALLBACK' }, `${callback.callbackName}: Request finished`);

        return pipe(
          validateOutput({ resource: callback, element }),
          E.mapLeft(violations => {
            pipe(violations, A.map(logViolation));
          }),
          TE.fromEither
        );
      })
    );
  };
}

function assembleRequest({
  resource,
  request,
  response,
}: {
  resource: IHttpCallbackOperation;
  request: IHttpRequest;
  response: IHttpResponse;
}) {
  const bodyAndMediaType = O.toUndefined(assembleBody(resource.request));
  return {
    url: resolveRuntimeExpressions(resource.path, request, response),
    requestData: {
      headers: O.toUndefined(assembleHeaders(resource.request, bodyAndMediaType && bodyAndMediaType.mediaType)),
      body: bodyAndMediaType && bodyAndMediaType.body,
      method: resource.method,
    },
  };
}

function assembleBody(request?: IHttpOperationRequest): O.Option<{ body: string; mediaType: string }> {
  return pipe(
    O.fromNullable(request),
    O.mapNullable(request => request.body),
    O.mapNullable(body => body.contents),
    O.chain(contents =>
      Do(O.option)
        .bind('param', head(contents))
        .bindL('body', ({ param }) => generateHttpParam(param))
        .done()
    ),
    O.chain(({ body, param: { mediaType } }) =>
      pipe(
        E.stringifyJSON(body, () => undefined),
        E.map(body => ({ body, mediaType })),
        O.fromEither
      )
    )
  );
}

function assembleHeaders(request?: IHttpOperationRequest, bodyMediaType?: string): O.Option<Dictionary<string>> {
  return pipe(
    O.fromNullable(request),
    O.mapNullable(request => request.headers),
    O.chain(params =>
      sequenceOption(
        params.map(param =>
          Do(O.option)
            .bind('value', generateHttpParam(param))
            .return(({ value }) => [param.name, value])
        )
      )
    ),
    O.reduce(
      pipe(
        O.fromNullable(bodyMediaType),
        O.map(mediaType => ({ 'content-type': mediaType }))
      ),
      (mediaTypeHeader, headers) => ({ ...headers, ...mediaTypeHeader })
    )
  );
}

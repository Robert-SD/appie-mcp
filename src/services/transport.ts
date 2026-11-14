export interface RequestOptions {
  method?: string;
  body?: any;
  query?: Record<string, any>;
}

export interface GraphqlOptions {
  /**
   * Field names whose `errors` entries represent a graceful empty/not-found
   * domain result rather than a fatal transport error.
   */
  allowPartialErrorPaths?: string[];
}

export interface AhTransport {
  request<T = any>(endpoint: string, options?: RequestOptions): Promise<T>;
  graphql<T = any>(
    operationName: string,
    query: string,
    variables?: Record<string, any>,
    options?: GraphqlOptions
  ): Promise<T>;
  invalidateCache(prefix: string): void;
}

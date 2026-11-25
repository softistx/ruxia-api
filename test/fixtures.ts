// The first error code of a GraphQL result, if any.
export const codeOf = (result: {
  errors?: readonly { extensions?: { code?: string } }[];
}) => result.errors?.[0]?.extensions?.code;

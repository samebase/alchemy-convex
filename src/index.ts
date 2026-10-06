// @samebase/alchemy-convex: Convex resources for Alchemy v2.
export {
  Code,
  type CodeAttributes,
  type CodeDeployment,
  type CodeProps,
  CodePushFailed,
  ConvexCliNotFound,
  DeployKeyMismatch,
  EnvironmentNeedsDeployKey,
  parseDeployOutput,
  PushTargetMismatch,
} from "./Code.ts";
export {
  ACCESS_TOKEN_ENV,
  Credentials,
  CredentialsError,
  fromConfig,
  fromToken,
} from "./Credentials.ts";
export {
  DefaultEnvironmentVariable,
  type DefaultEnvironmentVariableAttributes,
  type DefaultEnvironmentVariableProps,
  type DeploymentType,
} from "./DefaultEnvironmentVariable.ts";
export {
  Deploy,
  DeployArgumentError,
  type DeployAttributes,
  deployArgs,
  DeployOutputError,
  type DeployProps,
} from "./Deploy.ts";
export {
  DeployKey,
  type DeployKeyAction,
  type DeployKeyAttributes,
  DeployKeyIsCredential,
  type DeployKeyProps,
  DeployKeyRecoveryRequired,
} from "./DeployKey.ts";
export {
  AmbiguousDeployment,
  Deployment,
  type DeploymentAttributes,
  DeploymentIdentityChange,
  type DeploymentProps,
  ProductionDeploymentNotFound,
} from "./Deployment.ts";
export {
  EnvironmentVariable,
  type EnvironmentVariableAttributes,
  type EnvironmentVariableProps,
  VariableIdentityChange,
} from "./EnvironmentVariable.ts";
export { ConvexApiError, ManagementApi } from "./ManagementApi.ts";
export {
  PreviewDeployKey,
  type PreviewDeployKeyAttributes,
  type PreviewDeployKeyProps,
} from "./PreviewDeployKey.ts";
export {
  AmbiguousProject,
  CreatedProjectNotFound,
  type DeploymentRegion,
  Project,
  ProjectDeploymentChange,
  type ProjectAttributes,
  type ProjectProps,
  ProjectTeamChange,
} from "./Project.ts";
export { Providers, providers } from "./Providers.ts";

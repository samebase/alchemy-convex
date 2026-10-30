// @samebase/alchemy-convex: the Convex plane for Alchemy v2.
export { bindComponent, type ComponentBinding } from "./Component.ts";
export {
  ACCESS_TOKEN_ENV,
  Credentials,
  CredentialsError,
  DEPLOY_KEY_ENV,
  fromConfig,
  fromValues,
} from "./Credentials.ts";
export {
  AbsoluteRootDir,
  AmbiguousDeployment,
  Deployment,
  type DeploymentAttributes,
  DeploymentIdentityChange,
  type DeploymentInput,
  type DeploymentProps,
  ProductionDeploymentNotFound,
} from "./Deployment.ts";
export {
  HUB_PROJECT_NAME,
  HubClient,
  type HubClientAttributes,
  HubClientFailed,
  type HubClientProps,
  type HubDeploymentType,
} from "./HubClient.ts";
export { ConvexApiError, ManagementApi } from "./ManagementApi.ts";
export {
  AmbiguousProject,
  CreatedProjectNotFound,
  type DeploymentRegion,
  Project,
  ProjectDeploymentChange,
  type ProjectAttributes,
  ProjectNotFound,
  type ProjectProps,
  ProjectTeamChange,
} from "./Project.ts";
export { Providers, providers } from "./Providers.ts";
export {
  RUN_RECORD_KEY,
  type RunRecord,
  RunRecordError,
  runRecord,
  withRunRecord,
} from "./RunRecord.ts";
export { state, STORE_PROJECT_NAME } from "./State.ts";
export {
  CodePushFailed,
  ConvexAppNotFound,
  ConvexCliNotFound,
  EnvironmentNeedsDeployKey,
  type EnvValue,
  parseDeployOutput,
  PushTargetMismatch,
  type Source,
  VariablesOwnedBySomeoneElse,
} from "./Push.ts";

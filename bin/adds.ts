#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { AddsStack } from "../lib/adds-stack";

const app = new cdk.App();
new AddsStack(app, "AddsStack");

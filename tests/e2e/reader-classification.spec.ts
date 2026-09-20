import {expect,test} from "@playwright/test";
import {databaseQuery} from "./db";

test("reader engineering visibility distinguishes opaque artifacts from actual releases",()=>{
  const sha="59939c003f6b3eb8add709e5897f7bfbe3e9f4d8";
  const cases:[string,string,boolean][]=[
    ["release",`handoff-runtime-${sha}`,true],
    ["release",sha,true],
    ["release","nightly-202609110000",true],
    ["release","v0.3.0",false],
    ["release","OpenClaw v1.1.0",false],
    ["release",`v1.2.3-nightly-${sha}`,false],
    ["release",`Release notes for runtime-${sha}`,false],
    ["blog",`handoff-runtime-${sha}`,false],
  ];
  for(const [type,title,hidden] of cases) {
    expect(databaseQuery(`SELECT reader_is_opaque_engineering_release('${type}','${title}')`),title)
      .toBe(hidden?"t":"f");
  }
});

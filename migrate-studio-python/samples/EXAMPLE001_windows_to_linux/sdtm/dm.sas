/* Synthetic SDTM domain fixture */
%include "../../../../programs/sdtm/20260131_SYNTH/primary/autoexec.sas";
data dm;
  set source.dm_raw;
  studyid = "EXAMPLE001";
run;

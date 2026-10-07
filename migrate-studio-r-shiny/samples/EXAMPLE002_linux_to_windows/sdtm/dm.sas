/* Synthetic SDTM domain */
%include "/placeholder/linux/projects/EXAMPLE002/dev/programs/sdtm/autoexec.sas";
data dm;
  set source.dm_raw;
  studyid = "EXAMPLE002";
run;

/* Synthetic ADaM fixture */
%include "../../../../programs/sdtm/20260131_SYNTH/primary/autoexec.sas";
%setupanl;
libname trans xport "../../../../data/adam/20260131_SYNTH/primary/adae.xpt";
proc copy in=PADAM out=trans;
  select adae;
run;

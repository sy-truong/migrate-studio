/* Synthetic TLF report fixture */
%include "../../../../programs/tlf/20260131_SYNTH/primary/autoexec.sas";
%mheadfoot;
proc report data=padam.adae nowd;
run;
